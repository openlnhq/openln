# posBOX firmware

Standalone Lightning POS terminal firmware for the **ESP32-2432S028R** (Cheap Yellow Display)
with a **PN532 NFC reader**.

---

## Hardware

| Component | Notes |
|-----------|-------|
| ESP32-2432S028R (CYD) | AliExpress / various - ~$15 |
| PN532 NFC/RFID module | Set DIP switches: SW1=ON, SW2=OFF (I²C mode) - ~$4 |
| TMB12A05 active buzzer | Plugs into onboard SPEAK JST connector - ~$1 |
| 3D-printed enclosure | [Download 3MF](https://bitpos.app/posbox-enclosure.3mf) - print in PLA/PETG |

### PN532 wiring (I²C via CN1 JST connector)

| PN532 pin | CYD CN1 pin |
|-----------|-------------|
| VCC | 3.3 V |
| GND | GND |
| SDA | GPIO22 |
| SCL | GPIO27 |

---

## Build

Requires [PlatformIO](https://platformio.org/) CLI:

```bash
pip install platformio

# Build firmware
pio run --project-dir artifacts/esp32-pos

# Or use the helper script (builds + copies to API server public dir):
bash scripts/build-posbox.sh
```

The built binary lands at:
```
artifacts/esp32-pos/.pio/build/esp32dev/firmware.bin
```
`build-posbox.sh` copies it to:
```
artifacts/api-server/public/firmware/posbox-latest.bin
```
Commit this file - the API server serves it at `GET /api/firmware/posbox.bin` for
the WebSerial flash flow in the bitPOS PWA.

---

## Flash

**Via bitPOS PWA (recommended):**
1. Open bitPOS web app → Business → posBOX → Flash device
2. Plug ESP32 into your computer via USB
3. Click "Connect to device" - select the port in the Chrome/Edge dialog
4. Click "Flash firmware" - progress bar fills as the binary is written

**Via PlatformIO CLI:**
```bash
pio run --project-dir artifacts/esp32-pos --target upload
```

---

## Provisioning

On first boot the device advertises a BLE service named **posBOX**.

1. Open the bitPOS web app → Business → posBOX → Link device
2. Click "Scan for nearby device" and select **posBOX**
3. Enter your WiFi SSID and password
4. The app issues a device token and writes all credentials to the device over BLE
5. The device connects to WiFi, verifies the token, and enters the amount screen

---

## Factory reset

Hold the **BOOT** button (GPIO0) for **5 seconds**. The device clears its NVS credentials
and reboots into BLE provisioning mode.

---

## State machine

```
PROVISIONING ──(BLE provisioned)──▶ CONNECTING_WIFI
CONNECTING_WIFI ──(ok)──▶ IDLE_AMOUNT
CONNECTING_WIFI ──(fail)──▶ PROVISIONING  (clears NVS + reboots)

IDLE_AMOUNT ──(Pay tapped)──▶ CREATING_INVOICE
CREATING_INVOICE ──(bolt11)──▶ WAITING_PAYMENT
CREATING_INVOICE ──(error)──▶ IDLE_AMOUNT

WAITING_PAYMENT ──(QR paid or polled)──▶ SUCCESS
WAITING_PAYMENT ──(NFC, no PIN)──▶ LNURL_WITHDRAW → SUCCESS or ERROR
WAITING_PAYMENT ──(NFC, PIN)──▶ PIN_ENTRY
WAITING_PAYMENT ──(60 s or Cancel)──▶ IDLE_AMOUNT

PIN_ENTRY ──(confirmed)──▶ LNURL_WITHDRAW → SUCCESS or ERROR
PIN_ENTRY ──(Cancel)──▶ WAITING_PAYMENT

SUCCESS ──(3 s)──▶ IDLE_AMOUNT
ERROR ──(Retry)──▶ IDLE_AMOUNT
```

---

## Touch calibration

The default calibration values in `src/ui/Theme.h` work for most CYD units:

```c
#define TOUCH_CAL_DATA { 339, 3498, 237, 3595, 2 }
```

If touches are misaligned, run the `Touch_calibrate` example from TFT_eSPI,
note the five values it prints, and update `TOUCH_CAL_DATA`.

---

## Source layout

```
src/
  main.cpp                 State machine + setup/loop
  config/Config.h/.cpp     NVS read/write (ssid, pass, token, serverUrl, currency)
  ble/ProvisionService.h/.cpp   BLE GATT server for provisioning
  api/BitposClient.h/.cpp  HTTPS API client (invoice create/poll, LNURL, price)
  nfc/NfcReader.h/.cpp     PN532 NDEF URL reader
  screens/
    ProvisionScreen         BLE waiting animation
    AmountScreen            Numpad + amount display + Pay button
    PaymentScreen           QR code + NFC pulse + Cancel
    PinScreen               4-dot PIN entry
    ResultScreen            Full-screen success/error
  ui/
    Theme.h                 Colours, fonts, screen constants
    Numpad.h/.cpp           Shared numeric input widget
```
