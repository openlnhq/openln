# RIC checkout journal contract

`firmware/esp32-pos/src/core/CheckoutJournal.h` is a header-only, C++11 journal. It uses one committed Preferences blob at `ric-checkout/active`; reads use the built-in NVS status API because Preferences collapses read failures and missing keys to zero. No new libraries are required.

## Integration boundaries

- `CheckoutJournal::Kind`: `Receive=1`, `Withdraw=2`, `SendToCard=3`.
- `Record`: `kind`, `char reference[65]`, `uint64_t amountSats`, `bool dispatched`.
- `save(kind, reference, amountSats, dispatched) -> bool`. References are exact, case-preserved ASCII `[A-Za-z0-9_-]`, 16 through 64 characters. Sats must be 1 through 2147483647. Supply a payment hash, k1, or request ID for the matching QUERY endpoint, never a credential or invoice.
- Persist a receive/withdraw identity before displaying its payable QR. Set `dispatched=true` durably **before** any outgoing payment attempt. If saving fails, do not dispatch. The flag means "may have dispatched", not permission to dispatch again.
- One unresolved identity cannot be replaced, change kind/amount, or downgrade from dispatched to undispatched. Identical saves succeed without another write; the false-to-true transition writes one complete blob.
- `load(out) -> LoadResult`: `Missing`, `Valid`, `Corrupt`, `Unavailable`. Any non-valid result empties `out`. Reads never write or erase, including first boot.
- `recoveryAction(result)`: Missing -> None, Valid -> Query, everything else -> NeedsAttention. A valid record **always** recovers to QUERY, including undispatched receive records which may already have been paid through a QR. There is no automatic payment retry, resume, or timeout-based clear policy.
- `clear() -> bool`: call only after independently confirmed terminal status or explicit operator resolution. It removes only the active journal key and is idempotent when missing. A failed clear must keep checkout blocked until reconciled. A failed commit may have taken effect; false is never authorization to send.
- Calls must be serialized by the checkout loop. This is not a cross-task payment lock. Main/UI/API/engine integration is outside this header.

## Durable format

84 bytes: `RICJ`, version 1, kind byte, dispatched byte, reference-length byte, little-endian uint64 sats, 64 zero-padded reference bytes, little-endian CRC-32/ISO-HDLC over the preceding 80 bytes. No native struct padding, PIN, token, NFC secret, BOLT11, or fiat values are serialized. CRC detects accidental corruption, not malicious tampering.

## Native verification

From the repository root:

```sh
node --test tests/ric-checkout-journal.test.mjs
RIC_JOURNAL_SANITIZERS=1 node --test tests/ric-checkout-journal.test.mjs
```

The tests compile the actual production header, not a reimplementation of the journal. Host shims reproduce NVS handles, durable versus uncommitted writes, Preferences commits, and fault returns. They cover reboot identity recovery for all kinds/dispatch states, missing versus unreadable storage, every single-bit mutation and truncated record length, wrong versions/types, valid-checksum invalid fields, input/amount boundaries, namespace-scoped terminal clear, no poll writes, failed set/commit/erase/open/read, and ambiguous commits. A golden record generated independently with Python `struct`/`zlib` checks the serialized format and ensures trailing input memory is not persisted.

These are host fault-model tests, not a physical flash power-cut or device UI test.
