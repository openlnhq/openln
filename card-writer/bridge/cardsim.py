"""
Strict NTAG424 DNA card simulation — Python twin of tests/mock.mjs.

Validates real protocol semantics: session derivation, command MACs, counters,
EV2 padding, ChangeKey KeyData rules (XOR + CRC32 NK), SDM file settings, and
SDM mirroring on plain reads (p= / c= splice with empty-message CMAC) — the
same wire behavior the openLN server verifies on taps.

Used by the bridge's --sim mode so the full write/wipe stack can be exercised
end-to-end without NFC hardware.

Requires: pip install cryptography
"""

import os
from binascii import crc32
from cryptography.hazmat.primitives import cmac
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


# ── primitives ──────────────────────────────────────────────────────────────

def aes_ecb_block(key, block):
    """Single-block ECB encryption.

    Note: ECB here is intentional and protocol-mandated, not data encryption —
    DESFire EV2 secure messaging derives IVs as IV = E(K, counter||...): one
    single 16-byte block, no multi-block ECB data ever touches this.
    """
    enc = Cipher(algorithms.AES(bytes(key)), modes.ECB()).encryptor()
    return enc.update(bytes(block)) + enc.finalize()


def aes_cbc_enc(key, data, iv):
    enc = Cipher(algorithms.AES(bytes(key)), modes.CBC(bytes(iv))).encryptor()
    return enc.update(bytes(data)) + enc.finalize()


def aes_cbc_dec(key, data, iv):
    dec = Cipher(algorithms.AES(bytes(key)), modes.CBC(bytes(iv))).decryptor()
    return dec.update(bytes(data)) + dec.finalize()


def aes_cmac(key, data):
    c = cmac.CMAC(algorithms.AES(bytes(key)))
    c.update(bytes(data))
    return c.finalize()


def truncate_mac(mac16):
    return bytes(mac16[1::2])[:8]


def crc_jam(data):
    return crc32(bytes(data)) ^ 0xFFFFFFFF


def xor_bytes(a, b):
    return bytes(x ^ y for x, y in zip(a, b))


def rot_left1(data):
    return bytes(data[1:]) + bytes(data[:1])


def strip_pad(dec):
    i = len(dec) - 1
    while i >= 0 and dec[i] == 0x00:
        i -= 1
    if i < 0 or dec[i] != 0x80:
        raise ValueError("cardsim: invalid EV2 padding")
    return dec[:i]


def ascii_hex_bytes(hex_lower):
    return hex_lower.encode("ascii")


SW = {
    "OK": 0x9100, "AF": 0x91AF, "ISO_OK": 0x9000, "ISO_SEC": 0x6982,
    "INTEGRITY": 0x911E, "AUTH": 0x91AE, "ILLEGAL": 0x911C,
    "PARAM": 0x919E, "LENGTH": 0x917E, "FILE_NOT_FOUND": 0x91F0,
    "ABORTED": 0x91CA,
}


class CardSim:
    """One NTAG424 DNA card. transceive(apdu) -> response bytes (data+SW)."""

    def __init__(self, uid="04a1b2c3d4e580", keys=None, rng_bytes=None):
        self.uid = bytes.fromhex(uid)
        self.keys = [
            bytes.fromhex(k) if k else bytes(16)
            for k in (keys or [None] * 5)
        ]
        assert len(self.keys) == 5
        self.key_versions = [0, 0, 0, 0, 0]
        self.ndef_file = b""
        self.settings = {
            "raw": bytes.fromhex("40e0ee01ffff"), "sdm": False,
            "meta_key_no": None, "file_key_no": None,
            "enc_picc_offset": 0, "mac_offset": 0,
        }
        self.sdm_read_ctr = 0
        self.rid = False
        self.rid_value = None
        self.session = None
        self.pending_auth = None
        self.pending_version_stage = 0
        self.current_file = None
        self.rng_bytes = rng_bytes or (lambda tag, n: os.urandom(n))
        self.log = []

    # ── plumbing ────────────────────────────────────────────────────────────

    @staticmethod
    def _r(sw, data=b""):
        return bytes(data) + bytes([(sw >> 8) & 0xFF, sw & 0xFF])

    def transceive(self, apdu):
        apdu = bytes(apdu)
        out = self._handle(apdu)
        self.log.append((apdu.hex(), out.hex()))
        return out

    def _rand(self, tag, n=16):
        return bytes(self.rng_bytes(tag, n))

    def state(self):
        s = self.settings
        return {
            "uid": self.uid.hex(),
            "keys": [k.hex() for k in self.keys],
            "key_versions": list(self.key_versions),
            "ndef": self.ndef_file.hex(),
            "settings": s["raw"].hex(),
            "sdm": s["sdm"],
            "meta_key_no": s["meta_key_no"],
            "file_key_no": s["file_key_no"],
            "enc_picc_offset": s["enc_picc_offset"],
            "mac_offset": s["mac_offset"],
            "sdm_read_ctr": self.sdm_read_ctr,
            "rid": self.rid,
        }

    # ── dispatch ────────────────────────────────────────────────────────────

    def _handle(self, apdu):
        cla = apdu[0] if apdu else 0
        ins = apdu[1] if len(apdu) > 1 else 0
        if cla == 0x00:
            return self._iso(apdu)
        if cla == 0x90:
            return self._native(apdu)
        if cla == 0xFF and ins == 0xCA:
            return self._direct_uid()
        return self._r(0x6E00)

    # ── ISO 7816-4 layer ────────────────────────────────────────────────────

    def _iso(self, apdu):
        ins = apdu[1]
        if ins == 0xA4:
            p1 = apdu[2]
            if p1 == 0x04 and len(apdu) >= 5:
                lc = apdu[4]
                name = apdu[5:5 + lc].hex()
                if name != "d2760000850101":
                    return self._r(0x6A82)
                self.current_file = None
                self.session = None  # selecting the DF resets authentication
                return self._r(SW["ISO_OK"])
            if p1 == 0x00 and len(apdu) >= 7:
                fid = (apdu[5] << 8) | apdu[6]
                if fid not in (0xE103, 0xE104):
                    return self._r(0x6A82)
                self.current_file = fid
                return self._r(SW["ISO_OK"])
            return self._r(0x6A86)
        if ins == 0xB0:  # read binary
            if not self.current_file:
                return self._r(SW["ISO_SEC"])
            offset = (apdu[2] << 8) | apdu[3]
            le = apdu[4] if len(apdu) > 4 else 0
            content = self._cc_file() if self.current_file == 0xE103 else self._sdm_read()
            n = min(256, max(0, len(content) - offset)) if le == 0 else le
            return self._r(SW["ISO_OK"], content[offset:min(len(content), offset + n)])
        if ins == 0xD6:  # update binary
            if self.current_file != 0xE104:
                return self._r(SW["ISO_SEC"])
            if not self._can_write():
                return self._r(SW["ISO_SEC"])
            lc = apdu[4]
            data = apdu[5:5 + lc]
            size = (data[0] << 8) | data[1]
            if len(data) < 2 + size:
                return self._r(0x6700)
            self.ndef_file = data[0:2] + data[2:2 + size]
            return self._r(SW["ISO_OK"])
        return self._r(0x6D00)

    @staticmethod
    def _cc_file():
        return bytes([0x00, 0x0F, 0x20, 0x00, 0x3B, 0x04, 0x06, 0xE1, 0x04, 0x00, 0xFF, 0x00, 0x00])

    def _can_write(self):
        write_ar = self.settings["raw"][2] & 0x0F
        if write_ar == 0x0E:
            return True
        s = self.session
        return s is not None and write_ar == 0x00 and s["key_no"] == 0

    def _sdm_read(self):
        """NDEF read with SDM mirroring (this is what a tap sees)."""
        content = bytearray(self.ndef_file)
        s = self.settings
        if not s["sdm"] or len(content) == 0:
            return bytes(content)
        ctr = self.sdm_read_ctr
        ctr_b = bytes([ctr & 0xFF, (ctr >> 8) & 0xFF, (ctr >> 16) & 0xFF])
        # p = AES-CBC(K1, 0xC7 || UID || ctr(3 LE) || 00*5, IV=0)
        picc = bytes([0xC7]) + self.uid + ctr_b + bytes(5)
        p = aes_cbc_enc(self.keys[s["meta_key_no"]], picc, bytes(16)).hex()
        # c = truncate(CMAC(CMAC(K2, SV2), "")) with SV2 = 3CC300010080 || UID || ctr
        sv2 = bytes.fromhex("3CC300010080") + self.uid + ctr_b
        ses_key = aes_cmac(self.keys[s["file_key_no"]], sv2)
        c = truncate_mac(aes_cmac(ses_key, b"")).hex()
        pb, cb = ascii_hex_bytes(p), ascii_hex_bytes(c)
        if s["enc_picc_offset"] + len(pb) <= len(content):
            content[s["enc_picc_offset"]:s["enc_picc_offset"] + len(pb)] = pb
        if s["mac_offset"] + len(cb) <= len(content):
            content[s["mac_offset"]:s["mac_offset"] + len(cb)] = cb
        self.sdm_read_ctr = (ctr + 1) & 0xFFFFFF
        return bytes(content)

    # ── native layer ────────────────────────────────────────────────────────

    def _native(self, apdu):
        ins = apdu[1]
        lc = apdu[4] if len(apdu) > 4 else 0
        data = apdu[5:5 + lc]
        if ins == 0x60:  # GetVersion part 1
            self.pending_version_stage = 1
            return self._r(SW["AF"], self._version_part(1))
        if ins == 0xAF:  # continuation: auth part 2 or GetVersion 2/3
            if self.pending_auth:
                return self._auth_part2(data)
            if self.pending_version_stage == 1:
                self.pending_version_stage = 2
                return self._r(SW["AF"], self._version_part(2))
            if self.pending_version_stage == 2:
                self.pending_version_stage = 0
                return self._r(SW["OK"], self._version_part(3))
            return self._r(SW["ABORTED"])
        if ins == 0x71:
            return self._auth_part1(data)
        if ins == 0x64:  # GetKeyVersion (plain)
            key_no = data[0]
            if key_no > 4:
                return self._r(SW["PARAM"])
            return self._r(SW["OK"], bytes([self.key_versions[key_no]]))
        if ins == 0xAD:  # ReadData (plain read, SDM-spliced)
            file_no = data[0]
            if file_no != 2:
                return self._r(SW["FILE_NOT_FOUND"])
            off = int.from_bytes(data[1:4], "little")
            ln = int.from_bytes(data[4:7], "little")
            content = self._sdm_read()
            end = len(content) if ln == 0 else min(len(content), off + ln)
            return self._r(SW["OK"], content[off:max(off, end)])
        if ins == 0x51:
            return self._secure(apdu, lambda body, ctr: self._r_get_card_uid())
        if ins == 0xC4:
            return self._secure(apdu, self._r_change_key)
        if ins == 0x5F:
            return self._secure(apdu, self._r_change_file_settings)
        if ins == 0x5C:
            return self._secure(apdu, self._r_set_configuration)
        return self._r(SW["ILLEGAL"])

    def _version_part(self, n):
        if n in (1, 2):
            return bytes([0x04, 0x04, 0x02, 0x01, 0x00, 0x16, 0x03])
        return self.uid + bytes.fromhex("0102030405") + bytes([0x00, 0x00, 0x01, 0x19, 0x20, 0x00, 0x01])

    # ── auth ────────────────────────────────────────────────────────────────

    def _auth_part1(self, data):
        key_no = data[0]
        if key_no > 4:
            return self._r(SW["PARAM"])
        rnd_b = self._rand("rndB")
        self.pending_auth = {"key_no": key_no, "rnd_b": rnd_b}
        enc = aes_cbc_enc(self.keys[key_no], rnd_b, bytes(16))
        return self._r(SW["AF"], enc)

    def _auth_part2(self, data):
        pending = self.pending_auth
        self.pending_auth = None
        if not pending or len(data) != 32:
            return self._r(SW["LENGTH"])
        dec = aes_cbc_dec(self.keys[pending["key_no"]], data, bytes(16))
        rnd_a = dec[0:16]
        rnd_b_back = dec[16:32]
        if rnd_b_back != rot_left1(pending["rnd_b"]):
            return self._r(SW["AUTH"])

        ti = self._rand("ti", 4)
        rnd_mix = (
            rnd_a[0:2]
            + xor_bytes(rnd_a[2:8], pending["rnd_b"][0:6])
            + pending["rnd_b"][6:16]
            + rnd_a[8:16]
        )
        enc_key = aes_cmac(self.keys[pending["key_no"]], bytes.fromhex("A55A00010080") + rnd_mix)
        mac_key = aes_cmac(self.keys[pending["key_no"]], bytes.fromhex("5AA500010080") + rnd_mix)
        self.session = {
            "key_no": pending["key_no"], "enc_key": enc_key,
            "mac_key": mac_key, "ti": ti, "expected_ctr": 0,
        }

        plain = ti + rot_left1(rnd_a) + bytes(12)
        return self._r(SW["OK"], aes_cbc_enc(self.keys[pending["key_no"]], plain, bytes(16)))

    # ── secure messaging ────────────────────────────────────────────────────

    def _secure(self, apdu, handler):
        s = self.session
        if not s:
            return self._r(SW["AUTH"])
        lc = apdu[4]
        data = apdu[5:5 + lc]
        if len(data) < 8:
            return self._r(SW["LENGTH"])
        mac = data[-8:]
        body = data[:-8]
        ctr = s["expected_ctr"]
        exp = truncate_mac(aes_cmac(
            s["mac_key"], bytes([apdu[1]]) + ctr.to_bytes(2, "little") + s["ti"] + body,
        ))
        if exp != mac:
            return self._r(SW["INTEGRITY"])
        s["expected_ctr"] = (ctr + 1) & 0xFFFF
        return handler(body, ctr)

    def _decrypt_payload(self, enc, ctr):
        s = self.session
        assert s is not None
        iv = aes_ecb_block(s["enc_key"], bytes.fromhex("A55A") + s["ti"] + ctr.to_bytes(2, "little") + bytes(8))
        return strip_pad(aes_cbc_dec(s["enc_key"], enc, iv))

    def _r_get_card_uid(self):
        s = self.session
        assert s is not None
        ctr_resp = s["expected_ctr"]
        ivr = aes_ecb_block(s["enc_key"], bytes.fromhex("5AA5") + s["ti"] + ctr_resp.to_bytes(2, "little") + bytes(8))
        plain = self.uid + bytes([0x80]) + bytes(8)
        enc = aes_cbc_enc(s["enc_key"], plain, ivr)
        mac = truncate_mac(aes_cmac(s["mac_key"], bytes([0x00]) + ctr_resp.to_bytes(2, "little") + s["ti"] + enc))
        return self._r(SW["OK"], enc + mac)

    def _r_change_key(self, body, ctr):
        s = self.session
        assert s is not None
        if s["key_no"] != 0:
            return self._r(SW["AUTH"])
        key_no = body[0]
        if key_no > 4:
            return self._r(SW["PARAM"])
        dec = self._decrypt_payload(body[1:], ctr)
        if key_no == 0:
            if len(dec) < 17:
                return self._r(SW["LENGTH"])
            self.keys[0] = dec[0:16]
            self.key_versions[0] = dec[16]
            self.session = None  # changing key 0 invalidates the session
            return self._r(SW["OK"])
        if len(dec) < 21:
            return self._r(SW["LENGTH"])
        new_key = xor_bytes(dec[0:16], self.keys[key_no])
        version = dec[16]
        crc = dec[17:21]
        if crc != crc_jam(new_key).to_bytes(4, "little"):
            return self._r(SW["INTEGRITY"])
        self.keys[key_no] = new_key
        self.key_versions[key_no] = version
        return self._r(SW["OK"])

    def _r_change_file_settings(self, body, ctr):
        file_no = body[0]
        if file_no != 2:
            return self._r(SW["FILE_NOT_FOUND"])
        dec = self._decrypt_payload(body[1:], ctr)
        if len(dec) == 6:
            self.settings = {
                "raw": dec, "sdm": False, "meta_key_no": None, "file_key_no": None,
                "enc_picc_offset": 0, "mac_offset": 0,
            }
            return self._r(SW["OK"])
        if len(dec) == 15:
            meta_key_no = dec[5] >> 4
            file_key_no = dec[5] & 0x0F
            if meta_key_no > 4 or file_key_no > 4:
                return self._r(SW["PARAM"])
            self.settings = {
                "raw": dec, "sdm": True, "meta_key_no": meta_key_no,
                "file_key_no": file_key_no,
                "enc_picc_offset": int.from_bytes(dec[6:9], "little"),
                "mac_offset": int.from_bytes(dec[9:12], "little"),
            }
            return self._r(SW["OK"])
        return self._r(SW["LENGTH"])

    def _r_set_configuration(self, body, ctr):
        option = body[0]
        dec = self._decrypt_payload(body[1:], ctr)
        if option == 0x00 and len(dec) >= 1 and (dec[0] & 0x02):
            self.rid = True
            self.rid_value = bytes([0x08]) + self._rand("rid", 3)
        return self._r(SW["OK"])

    def _direct_uid(self):
        if self.rid and self.rid_value:
            return self._r(SW["ISO_OK"], self.rid_value)
        return self._r(SW["ISO_OK"], self.uid)
