#pragma once
#include <TFT_eSPI.h>

/**
 * On-device WiFi setup screen.
 *
 * Triggered from the AmountScreen settings gear icon, or from the WiFi
 * connecting screen's "Choose network" button when the provisioned network
 * is unreachable.  Lets the merchant switch WiFi without re-provisioning —
 * the Bearer token and server URL stay in NVS untouched.
 *
 * Flow:  scan → list → select → password entry (on-screen keyboard) → connect
 *
 * The keyboard is a compact 3-row QWERTY with shift + symbol toggle.
 * Reuses the touch + debounce pattern from Numpad / readTouch() in main.cpp.
 */
class WifiSetupScreen {
public:
    // Enter the screen — triggers a WiFi scan (2-4 s blocking).
    // Call from main.cpp's state machine; draw + scan happen here.
    static void enter(TFT_eSPI& tft);

    // Process touch input.  Returns:
    //   ""  — still in setup (no action needed by caller)
    //   "connected:<ssid>"  — WiFi connected, caller should resume normal ops
    //   "cancelled"         — user pressed back/cancel
    //
    // The caller (main.cpp) should call this every loop iteration and act on
    // the return value.  WiFi.begin() + connection wait happens inside here.
    static String handleTouch(TFT_eSPI& tft, int tx, int ty);

    // Periodic update — animates the "scanning..." / "connecting..." dots.
    // Returns:
    //   ""           — still working (scanning or connecting)
    //   "connected"  — WiFi connected (caller should save creds + resume)
    //   "failed"     — connect timeout (back to list, user can retry)
    //   "cancelled"  — user pressed back
    static String update(TFT_eSPI& tft);

    // After update() returns "connected", call these to get the SSID + password
    // the user entered, so they can be saved to NVS (keeping the Bearer token).
    static String getSelectedSsid();
    static String getSelectedPassword();

private:
    // ── Sub-screens ──────────────────────────────────────────────────────
    enum SubScreen { SCANNING, NETWORK_LIST, PASSWORD_ENTRY, CONNECTING };

    // ── Network entry ─────────────────────────────────────────────────────
    struct Network {
        char ssid[33];
        int  rssi;
        bool encrypted;
    };

    // ── Keyboard layout ───────────────────────────────────────────────────
    // 3 rows × 10 keys QWERTY. Space is a normal-width key at the end.
    // Compact layout: 34px keys, 36px rows → keyboard fits in 108px vertical.
    static const int KB_ROWS    = 3;
    static const int KB_COLS    = 10;
    static const int KB_KEY_W   = 32;   // 320 / 10 = 32px
    static const int KB_KEY_H   = 34;
    static const int KB_Y_OFFSET = 86;   // keyboard starts below the text field

    // Layout constants
    static const int LIST_Y      = 40;   // network list starts below header
    static const int LIST_ITEM_H = 36;   // height per network row
    static const int MAX_VISIBLE  = 5;    // max networks shown without scroll
    static const int MAX_NETWORKS = 15;   // scan result cap
    static const int PASS_FIELD_Y = 52;  // password text field Y position

    // State
    static SubScreen _sub;
    static Network   _networks[];
    static int       _networkCount;
    static int       _selectedNetwork;   // index in _networks, -1 = none
    static int       _scrollOffset;      // for scrolling the list

    // Password entry state
    static char      _password[65];
    static int       _passwordLen;
    static bool      _shiftMode;          // true = uppercase
    static bool      _symbolMode;         // true = numbers/symbols page

    // Scanning animation
    static uint32_t  _scanAnimLast;
    static int       _scanAnimFrame;

    // Connecting animation
    static uint32_t _connectStart;

    // ── Internal helpers ─────────────────────────────────────────────────
    static void doScan(TFT_eSPI& tft);
    static void drawNetworkList(TFT_eSPI& tft);
    static void drawPasswordEntry(TFT_eSPI& tft);
    static void drawKeyboard(TFT_eSPI& tft);
    static void drawPasswordField(TFT_eSPI& tft);
    static char handleKeyboardTouch(int tx, int ty);
    static const char* getKeyLabel(int row, int col);
    static void drawConnecting(TFT_eSPI& tft);
    static String signalBars(int rssi);
    static void drawScanning(TFT_eSPI& tft);
};
