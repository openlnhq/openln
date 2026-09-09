# Merchant trial workflow

openLN is the account interface for a user's own NIP-47 wallet, RIC terminals, and NTAG424 Bolt Cards. openLN does not store a spendable customer balance. The connected wallet provider determines its custody model.

1. Create an account and connect the wallet's NWC connection string. Allow balance, invoice creation, payment, and lookup in that wallet.
2. In Settings, choose the counter currency (including ZAR). Buy / Receive and Sell / Send have separate rate adjustments. Blank means market rate; `ZAR*1.02` adjusts the BTC/ZAR price before converting to sats per rand. Restart a linked RIC after saving settings to refresh its boot-time config.
3. Cards → Issue card → set a name, 4-digit payment PIN, and per-payment/daily limits. Each person's cards belong to their own account, not the merchant's.
4. Write the card with a linked RIC (Settings → Issue Card) or Bolt Card NFC Creator on Android using the one-time setup QR. The QR's URL is for the creator app, not a normal browser; reading it consumes the token. An active, unwritten card can get a fresh setup link without replacing its keys.
5. RIC → Link your RIC for an already-flashed unit. Install firmware only for a new unit matching the declared board. The current distributed factory image is ESP32-2432S028R, not ESP32-S3/ES3C28P.
6. Customer payments at RIC use a Lightning invoice: customer scans QR or taps a Bolt Card. A wrapped 100-sat receipt forwards 98 sats and collects 2 sats. The existing fee rounds up in whole sats while retaining at least one sat for the merchant; the unchanged money engine may fall back to an unwrapped invoice when a wrap cannot be safely created.

## Card safety

Freeze temporarily blocks spending. Cancel permanently blocks that card record; neither erases the chip. Wipe uses the current keys to reset the physical chip through RIC or the Android creator app; only confirm the wipe after the writer reports success. Recovery keys are retained rather than rotated before hardware success. Reuse a wiped blank chip by issuing a new card record.

Standard Web NFC cannot execute NTAG424's authentication/ChangeKey APDUs. Browser-only security-key writing is not implemented in the bitPOS reference either: its browser displays a creator-app QR and its writer is a native Android app. No browser-only physical-write claim is made.

## Verification boundary

Automated integration tests exercise real PostgreSQL, real AES-SUN taps, token/QR provisioning, device-token auth, limits, PIN lockout and cancellation. Desktop/mobile browser tests click the actual forms. A real external 100-sat hold payment settled with a 98-sat increase at the test merchant; a separate 21-sat card payment recorded `completed` and paid its destination. No physical RIC or NTAG424 was attached during this release; final hardware write/wipe/link/flash and firmware-side rate refresh need a bench test.
