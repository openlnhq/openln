#include <Arduino.h>
#include <WiFi.h>
#include <esp_task_wdt.h>
#include <SPI.h>
#include <TFT_eSPI.h>

// ── Firmware version ────────────────────────────────────────────────────────
// Checked against the server on boot for OTA updates.
#include "core/Version.h"
#include <XPT2046_Touchscreen.h>

#include "config/Config.h"
#include "ble/ProvisionService.h"
#include "api/BitposClient.h"
#include "nfc/NfcReader.h"
#include "buzzer/Buzzer.h"
#include "screens/ProvisionScreen.h"
#include "screens/AmountScreen.h"
#include "screens/PaymentScreen.h"
#include "screens/PinScreen.h"
#include "screens/ResultScreen.h"
#include "screens/WifiSetupScreen.h"
#include "screens/SettingsMenu.h"
#include "nfc/NfcWriter.h"
#include "ui/Theme.h"
#include "api/OTAManager.h"

// ──────────────────────────────────────────────────────────────────────────────
// Global hardware objects
// ──────────────────────────────────────────────────────────────────────────────
TFT_eSPI tft;

// CYD touch — XPT2046 is on VSPI (different bus from display HSPI).
// VSPI: SCK=25, MISO=39, MOSI=32  CS=33  IRQ=36
static SPIClass           touchSpi(VSPI);
static XPT2046_Touchscreen touch(33, 36); // CS=33, IRQ=36

// ──────────────────────────────────────────────────────────────────────────────
// Rate modifier parser — applies a modifier string like "THB*0.99" to a price.
// Returns the modified price, or the original if the modifier is empty/invalid.
// Format: <currency_code><ops> where ops is *N, +N, -N, /N (can chain).
// Example: "thb*0.99" → price * 0.99
//          "thb-0.5"  → price - 0.5
// ──────────────────────────────────────────────────────────────────────────────
static float applyModifier(float price, const String& modifier) {
    if (modifier.isEmpty() || price <= 0) return price;
    String expr = modifier;
    expr.trim();
    expr.toLowerCase();
    // Skip the currency code prefix (3-5 letters)
    int i = 0;
    while (i < (int)expr.length() && expr.charAt(i) >= 'a' && expr.charAt(i) <= 'z') i++;
    if (i >= (int)expr.length()) return price;
    // Parse remaining ops: *N, +N, -N, /N chains
    float result = price;
    while (i < (int)expr.length()) {
        char op = expr.charAt(i++);
        if (op != '*' && op != '+' && op != '-' && op != '/') return result;
        // Parse the number after the operator
        String numStr;
        while (i < (int)expr.length() &&
               (expr.charAt(i) == '.' || (expr.charAt(i) >= '0' && expr.charAt(i) <= '9'))) {
            numStr += expr.charAt(i++);
        }
        if (numStr.isEmpty()) return result;
        float val = numStr.toFloat();
        switch (op) {
            case '*': result *= val; break;
            case '+': result += val; break;
            case '-': result -= val; break;
            case '/': result /= val; break;
        }
    }
    return result;
}

// Compute effective sats-per-unit, applying the send rate modifier in send mode.
// (Defined after satsPerUnit and sendRateModifier are declared — see below.)
float effectiveSatsPerUnit();

// ──────────────────────────────────────────────────────────────────────────────
// Application state machine
// ──────────────────────────────────────────────────────────────────────────────
enum AppState {
    STATE_PROVISIONING,
    STATE_CONNECTING_WIFI,
    STATE_IDLE_AMOUNT,
    STATE_CREATING_INVOICE,
    STATE_WAITING_PAYMENT,
    STATE_PIN_ENTRY,
    STATE_SUCCESS,
    STATE_ERROR,
    STATE_WIFI_SETUP,
    STATE_SEND_PIN_ENTRY,
    STATE_SEND_WAITING,
    STATE_SETTINGS_MENU,
    STATE_CARD_WRITE,
    STATE_CARD_WIPE,
    STATE_CARD_READ,
    STATE_UPDATES,
};

static AppState state = STATE_PROVISIONING;
static uint32_t serverRetryAt=0, serverRetryMs=2000, lastHelloAt=0, nextOtaCheck=0;
static bool serverAuthenticated=false;
static void drawUpdateScreen();
static void handleUpdateScreen();

// Payment context preserved across NFC → PIN → settle flow
static Invoice  currentInvoice;
static String   currentCardUid;
static String   lastError;
static long     currentAmountSats = 0;

// LNURL-withdraw context — stored separately to avoid URL reconstruction bugs
static String   lnurlCallback;    // raw callback URL (may already contain '?')
static String   lnurlK1;         // k1 value from LNURL-withdraw response

// Set true once callLnurlCallback() succeeds; stops NFC polling,
// continues invoice-status polling until paid/expired/timeout.
static bool lnurlCallbackSent = false;

// Price cache
static float    satsPerUnit       = 0.0f;   // currently displayed sats per unit
static float    baseSatsPerUnit   = 0.0f;   // raw sats per unit before modifiers
static uint32_t priceLastFetched  = 0;
static String   receiveRateModifier;
static String   sendRateModifier;           // e.g. "THB*0.99" — applied in send mode
static const uint32_t PRICE_TTL_MS = 5UL * 60UL * 1000UL; // 5 min

// Compute effective sats-per-unit, applying the send rate modifier in send mode.
float effectiveSatsPerUnit() {
    if (satsPerUnit <= 0.0f) return satsPerUnit;
    const String& modifier = AmountScreen::isSendMode() ? sendRateModifier : receiveRateModifier;
    if (!modifier.isEmpty()) {
        float rawPrice = 100000000.0f / baseSatsPerUnit;
        float modPrice = applyModifier(rawPrice, modifier);
        if (modPrice > 0) return 100000000.0f / modPrice;
    }
    return satsPerUnit;
}

// Polling
static uint32_t invoiceCreateTime = 0;
static const uint32_t INVOICE_TIMEOUT_MS = 60000;
static uint32_t lastStatusPoll = 0;
static const uint32_t POLL_INTERVAL_MS = 2000;
static int      pollFailCount      = 0;      // consecutive HTTP errors; resets on good response
static uint32_t currentPollInterval = POLL_INTERVAL_MS; // grows with exponential back-off

// Grace period after the on-screen invoice timeout when a LNURL callback has
// been sent — the card was charged, the payment is in flight.  We keep polling
// the invoice status so the device doesn't lose visibility of a settlement that
// arrives a few seconds after the screen would normally give up.
static const uint32_t PAYMENT_GRACE_MS = 90000; // 90 s grace after timeout
static bool     paymentInFlightAtTimeout = false;
static uint32_t invoiceTimeoutAt         = 0;

// WiFi watchdog — reconnect if connection lost for >5 s in any operational state
static uint32_t wifiConnectStart        = 0;
static uint32_t wifiLostAt             = 0;
static bool     paymentInterruptedByWifi = false; // true when WiFi dropped mid-payment

// WiFi connecting screen animation state (reset by enterConnectingWifi)
static uint32_t wifiAnimLast  = 0;
static int      wifiAnimFrame = 0;

// Price retry interval when price is unknown (shorter than full TTL)
static const uint32_t PRICE_RETRY_MS = 30000; // 30 s between retries when price = 0

// Screen sleep — backlight off after 2 min of no touch in STATE_IDLE_AMOUNT.
// Touch controller stays powered; next touch wakes the screen instantly.
static const uint32_t SCREEN_DIM_MS = 2UL * 60UL * 1000UL; // 2 minutes
static uint32_t lastActivityMs = 0;   // millis() of last touch in idle state
static bool     screenOff      = false;

// Factory reset
static const int BOOT_BTN_PIN       = 0;
static uint32_t bootBtnPressStart   = 0; // millis() when button first went LOW

// ──────────────────────────────────────────────────────────────────────────────
// Touch helpers — XPT2046_Touchscreen on VSPI
// ──────────────────────────────────────────────────────────────────────────────
static bool readTouch(int& tx, int& ty) {
    // Leading-edge detection: only register the FIRST frame of a new touch.
    // This prevents a held finger from firing repeatedly every 50 ms loop.
    // The 200 ms debounce guards against XPT2046 noise between frames.
    static bool  prevTouched  = false;
    static uint32_t lastTouchMs = 0;

    bool isTouched = touch.touched();
    bool isNew     = isTouched && !prevTouched;
    prevTouched    = isTouched;

    if (!isNew)                                 return false;
    if (millis() - lastTouchMs < 200)           return false;
    lastTouchMs = millis();

    TS_Point p = touch.getPoint();
    // CYD (ESP32-2432S028R) rotation=1: XPT2046 p.x increases left→right,
    // p.y increases top→bottom — same direction as screen coords, no inversion.
    tx = map(p.x, TOUCH_X_MIN, TOUCH_X_MAX, 0, SCREEN_W - 1);
    ty = map(p.y, TOUCH_Y_MIN, TOUCH_Y_MAX, 0, SCREEN_H - 1);
    tx = constrain(tx, 0, SCREEN_W - 1);
    ty = constrain(ty, 0, SCREEN_H - 1);
    DBG_PRINTF("Touch: raw(%d,%d) → screen(%d,%d)\n", p.x, p.y, tx, ty);
    return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// State transitions
// ──────────────────────────────────────────────────────────────────────────────
static void enterIdleAmount(); // forward declaration — defined after handleConnectingWifi
static void enterProvisioning() {
    state = STATE_PROVISIONING;
    Config::clear();
    ProvisionService::begin();
    ProvisionScreen::draw(tft);
}

static void enterConnectingWifi() {
    state            = STATE_CONNECTING_WIFI;
    wifiConnectStart = millis();
    wifiLostAt       = 0;               // reset watchdog so it doesn't re-fire immediately
    currentPollInterval = POLL_INTERVAL_MS; // reset back-off for next invoice
    wifiAnimLast     = 0;               // reset animation so dots start immediately
    wifiAnimFrame    = 0;
    ProvisionService::setStatus("connecting");

    tft.fillScreen(COL_BG);
    tft.setTextDatum(MC_DATUM);
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_MUTED, COL_BG);
    tft.drawString("Connecting to WiFi", SCREEN_W / 2, SCREEN_H / 2 - 22);
    tft.setTextColor(COL_TEXT, COL_BG);
    tft.drawString(Config::ssid, SCREEN_W / 2, SCREEN_H / 2 + 4);
    // Cancel button — tap to wipe credentials and return to BLE provisioning.
    // Far more discoverable than "Hold BOOT 5s to reset" when the password is wrong.
    tft.fillRoundRect((SCREEN_W - 140) / 2, 202, 140, 32, 6, tft.color565(180, 40, 40));
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(TFT_WHITE, tft.color565(180, 40, 40));
    tft.drawString("Cancel", SCREEN_W / 2, 218);

    WiFi.setAutoReconnect(true);
    WiFi.begin(Config::ssid.c_str(), Config::pass.c_str());
}

static void handleConnectingWifi() {
    wl_status_t s = WiFi.status();
    if (s == WL_CONNECTED) {
        DBG_PRINTLN("WiFi connected: " + WiFi.localIP().toString());

        BitposClient::init(Config::serverUrl, Config::token);

        // Pre-allocate all String fields that grow during transactions.
        // reserve() grabs memory once here; subsequent String assignments
        // reuse the same physical buffer (no realloc) as long as content fits.
        // Combined with BitposClient's pre-allocated _respBuf and _urlBuf,
        // heap allocation is effectively O(1) after the first transaction.
        currentInvoice.bolt11.reserve(512);      // bolt11: 250-500 chars typical
        currentInvoice.paymentHash.reserve(64);  // sha256 hex: 64 chars
        currentInvoice.expiresAt.reserve(32);
        currentCardUid.reserve(32);
        lnurlCallback.reserve(384);              // LNURL callback URL
        lnurlK1.reserve(64);

        // A real authenticated handshake, not a deliberately missing invoice.
        // Offline, 5xx, TLS errors and rejection are distinct. Never erase NVS
        // or reboot-loop because a server is unavailable or returns 401.
        if (serverRetryAt && !RicPolicy::due(millis(),serverRetryAt)) return;
        auto authState=DeviceLink::hello();
        if (authState!=RicPolicy::AuthState::Accepted) {
            serverAuthenticated=false;
            const bool rejected=authState==RicPolicy::AuthState::Rejected;
            ProvisionService::setStatus(rejected?"error:token_invalid":"error:server_unreachable");
            OTAManager::display(tft,rejected?"Device link rejected":"Reconnecting to openLN",
                               rejected?"Check this device in your account":"Saved settings kept. Retrying.");
            serverRetryMs=rejected?60000:std::min(serverRetryMs*2,60000U);
            serverRetryAt=millis()+serverRetryMs+(esp_random()%1000);
            return;
        }
        serverAuthenticated=true;lastHelloAt=millis();serverRetryAt=0;serverRetryMs=2000;

        // Override currency from the server (merchant's account setting) so the
        // device always follows the web app — not the value baked into NVS at
        // provision time. Falls back to the provisioned currency on any error.
        // Also fetch the send rate modifier (applied in send mode).
        String srvReceiveMod;
        String srvSendMod;
        String serverCurrency = BitposClient::fetchCurrency(srvReceiveMod, srvSendMod);
        if (!serverCurrency.isEmpty()) {
            Config::currency = serverCurrency;
            DBG_PRINTLN("Currency from server: " + Config::currency);
        }
        receiveRateModifier = srvReceiveMod;
        sendRateModifier = srvSendMod;
        if (!sendRateModifier.isEmpty()) {
            DBG_PRINTLN("Send rate modifier: " + sendRateModifier);
        }

        // Fetch initial price
        satsPerUnit = BitposClient::fetchPrice(Config::currency);
        baseSatsPerUnit = satsPerUnit;
        priceLastFetched = millis();

        if (ProvisionService::isActive()) {
            // Came from BLE provisioning — notify phone then restart cleanly.
            // Do NOT call ProvisionService::stop() / deinit(true): it races with
            // a pending NimBLE callback and crashes with PC=0x00000000.
            // Config is committed to NVS; after restart isProvisioned()=true and
            // the device boots straight into POS mode without touching BLE.
            ProvisionService::setStatus("connected");
            delay(2000);
            ESP.restart();
            return;
        }

        AmountScreen::setPrice(effectiveSatsPerUnit(), Config::currency);
        
        // OTA check — compare firmware version with server, update if available
        OTAManager::bootConfirmed();
        OTAManager::checkAndUpdate(tft);
        nextOtaCheck=millis()+900000+(esp_random()%60000);
        
        enterIdleAmount();

    } else {
        // Cancel button hit-test — tap wipes credentials and re-enters BLE provisioning.
        // Button is drawn at enterConnectingWifi(): fillRoundRect(90, 202, 140, 32).
        // readTouch() is leading-edge only, so a single tap fires once.
        int tx, ty;
        if (readTouch(tx, ty)) {
            if (tx >= 90 && tx < 230 && ty >= 202 && ty < 234) {
                DBG_PRINTLN("WiFi cancel tapped — clearing config, entering provisioning");
                WiFi.disconnect(true);
                delay(100);
                enterProvisioning();
                return;
            }
        }

        // Log WiFi status every 3 s so the serial monitor shows progress
        static uint32_t lastWifiLog = 0;
        if (millis() - lastWifiLog > 3000) {
            lastWifiLog = millis();
            DBG_PRINTF("WiFi status: %d  SSID: %s\n", (int)s, Config::ssid.c_str());
        }
        // 3-dot bounce animation while waiting for WiFi — updates every 500 ms.
        // Only the dot row is redrawn; title + SSID remain from enterConnectingWifi().
        if (millis() - wifiAnimLast > 500) {
            wifiAnimLast  = millis();
            wifiAnimFrame = (wifiAnimFrame + 1) % 3;
            const int dotY = 175, dotR = 10, gap = 44, cx = SCREEN_W / 2;
            tft.fillRect(0, dotY - dotR - 6, SCREEN_W, (dotR + 6) * 2, COL_BG);
            for (int i = 0; i < 3; i++) {
                int  x   = cx + (i - 1) * gap;
                bool lit = (i == wifiAnimFrame);
                int  yOff = lit ? -4 : 0;
                if (lit) tft.fillCircle(x, dotY + yOff, dotR, COL_ACCENT);
                else     tft.drawCircle(x, dotY + yOff, dotR, COL_MUTED);
            }
        }
        if (RicPolicy::elapsed(millis(),wifiConnectStart,40000)) {
            // Keep configuration and retry without rebooting or erasing NVS.
            ProvisionService::setStatus("error:wifi_timeout");
            wifiConnectStart=millis();
            DeviceLink::release();
            WiFi.reconnect();
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// WiFi setup — on-device network switching without re-provisioning
// ──────────────────────────────────────────────────────────────────────────────
static void enterWifiSetup() {
    state = STATE_WIFI_SETUP;
    screenOff = false;
    ledcWrite(0, 255);
    WifiSetupScreen::enter(tft);
}

static void handleWifiSetup() {
    // Check for connection result from update()
    String result = WifiSetupScreen::update(tft);

    if (result == "connected") {
        // Save new WiFi creds to NVS (keeps Bearer token + server URL)
        String newSsid = WifiSetupScreen::getSelectedSsid();
        String newPass = WifiSetupScreen::getSelectedPassword();
        Config::saveWifi(newSsid, newPass);

        // Re-init the API client (same token + server URL, just new WiFi)
        BitposClient::init(Config::serverUrl, Config::token);

        // Verify connectivity + auth on the new network
        if (!BitposClient::healthCheck()) {
            DBG_PRINTLN("WiFi switched but server unreachable on new network");
            lastError = "Connected but server unreachable";
            ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Connection error");
            state = STATE_ERROR;
            return;
        }

        // Refresh price for the new connection
        satsPerUnit = BitposClient::fetchPrice(Config::currency);
        priceLastFetched = millis();
        AmountScreen::setPrice(effectiveSatsPerUnit(), Config::currency);

        DBG_PRINTLN("WiFi switched successfully — resuming normal ops");
        enterIdleAmount();
        return;
    }

    if (result == "cancelled") {
        // User pressed back — return to amount screen
        enterIdleAmount();
        return;
    }

    // Still working — handle touch input
    int tx, ty;
    if (!readTouch(tx, ty)) return;
    String touchResult = WifiSetupScreen::handleTouch(tft, tx, ty);
    if (touchResult == "cancelled") {
        enterIdleAmount();
    }
}

// Enter the idle amount screen from any state.
// Guarantees backlight is on, resets idle timer, draws the amount screen.
// Always use this instead of setting state = STATE_IDLE_AMOUNT directly so
// screen-sleep state is consistent regardless of which path returns to idle.
static void enterIdleAmount() {
    screenOff      = false;
    lastActivityMs = millis();
    ledcWrite(0, 255);          // backlight on — may be no-op if already on
    AmountScreen::cancelPayHold();  // clear any stale hold state
    AmountScreen::draw(tft);
    state = STATE_IDLE_AMOUNT;
}

static void handleIdleAmount() {
    int tx, ty;

    // Hold detection for send mode: check if finger is currently on the pay button.
    // readTouch() is leading-edge only (fires once per tap), so we use
    // touch.touched() directly for hold tracking — polled every 50ms by the loop.
    if (touch.touched()) {
        TS_Point p = touch.getPoint();
        int htx = map(p.x, TOUCH_X_MIN, TOUCH_X_MAX, 0, SCREEN_W - 1);
        int hty = map(p.y, TOUCH_Y_MIN, TOUCH_Y_MAX, 0, SCREEN_H - 1);
        htx = constrain(htx, 0, SCREEN_W - 1);
        hty = constrain(hty, 0, SCREEN_H - 1);

        if (AmountScreen::isPayButtonHeld(htx, hty)) {
            if (!AmountScreen::isPayHoldActive()) {
                AmountScreen::startPayHold(htx, hty);
            } else if (AmountScreen::checkPayHold(millis())) {
                // 5 seconds held — toggle send mode
                AmountScreen::cancelPayHold();
                bool newMode = !AmountScreen::isSendMode();
                AmountScreen::setSendMode(newMode);
                DBG_PRINTLN(newMode ? "Send mode activated" : "Send mode deactivated");
                AmountScreen::draw(tft);
                Buzzer::playSuccess();
                // Wait for finger release
                while (touch.touched()) delay(50);
                return;
            }
        } else {
            AmountScreen::cancelPayHold();
        }
    } else {
        AmountScreen::cancelPayHold();
    }

    if (!readTouch(tx, ty)) return;

    // First touch while screen is dark wakes the backlight but is NOT forwarded
    // as input — the cashier shouldn't accidentally start entering digits in the dark.
    if (screenOff) {
        screenOff      = false;
        lastActivityMs = millis();
        ledcWrite(0, 255);
        AmountScreen::draw(tft);
        return;
    }

    lastActivityMs = millis();  // any successful touch resets the idle timer

    // Settings gear icon — opens settings menu (WiFi / Issue Card / Wipe / Read)
    if (AmountScreen::isSettingsTap(tx, ty)) {
        state = STATE_SETTINGS_MENU;
        screenOff = false;
        ledcWrite(0, 255);
        SettingsMenu::draw(tft);
        return;
    }

    bool pay = AmountScreen::handleTouch(tft, tx, ty);
    if (pay) {
        currentAmountSats = AmountScreen::getAmountSats();
        if (AmountScreen::isSendMode()) {
            // Send mode — go to PIN entry for merchant authentication (6-digit account PIN)
            state = STATE_SEND_PIN_ENTRY;
            PinScreen::draw(tft, "", 6);
        } else {
            // Normal mode — create invoice for receiving payment
            state = STATE_CREATING_INVOICE;
            tft.fillScreen(COL_BG);
            tft.setTextColor(COL_TEXT, COL_BG);
            tft.setTextDatum(MC_DATUM);
            tft.setTextFont(FONT_SMALL);
            tft.drawString("Creating invoice...", SCREEN_W / 2, SCREEN_H / 2);
        }
    }
}

static void handleCreatingInvoice() {
    // Animated "Creating invoice..." screen — same dot-bounce pattern used by
    // the PIN confirming screen so the UX language is consistent.
    // 3 pre-HTTP frames × 120 ms = 360 ms, then createInvoice() blocks (~1-3 s).
    tft.fillScreen(COL_BG);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(COL_TEXT, COL_BG);
    tft.setTextFont(FONT_SMALL);
    tft.drawString("Creating", SCREEN_W / 2, 78);
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_MUTED, COL_BG);
    tft.drawString("invoice...", SCREEN_W / 2, 114);
    {
        const int dotY = 155, dotR = 11, gap = 46, cx = SCREEN_W / 2;
        for (int frame = 0; frame < 4; frame++) {
            tft.fillRect(0, dotY - dotR - 8, SCREEN_W, (dotR + 8) * 2, COL_BG);
            for (int i = 0; i < 3; i++) {
                int  x   = cx + (i - 1) * gap;
                bool lit = (i == frame % 3);
                int  yOff = lit ? -5 : 0;
                if (lit) tft.fillCircle(x, dotY + yOff, dotR, COL_ACCENT);
                else     tft.drawCircle(x, dotY + yOff, dotR, COL_MUTED);
            }
            if (frame < 3) delay(120);   // animate 3 frames; frame 3 holds during HTTP
        }
    }

    String err;
    currentInvoice = BitposClient::createInvoice(currentAmountSats, err);

    if (!err.isEmpty() || currentInvoice.bolt11.isEmpty()) {
        lastError = err.isEmpty() ? "Failed to create invoice" : err;
        ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Invoice failed");
        state = STATE_ERROR;
        return;
    }

    invoiceCreateTime   = millis();
    lastStatusPoll      = 0;
    pollFailCount       = 0;
    currentPollInterval = POLL_INTERVAL_MS;
    lnurlCallbackSent   = false;
    lnurlCallback       = "";
    lnurlK1             = "";
    paymentInFlightAtTimeout = false;   // reset grace-period state for this invoice
    invoiceTimeoutAt         = 0;
    PaymentScreen::draw(tft, currentInvoice.bolt11, currentAmountSats, AmountScreen::fiatLabel(), INVOICE_TIMEOUT_MS / 1000);
    state = STATE_WAITING_PAYMENT;
}

static void handleWaitingPayment() {
    // Timeout — with grace period for in-flight payments.
    // If the LNURL callback has been sent, the customer's card was charged and
    // the payment is in flight.  Returning to idle here would lose visibility of
    // a settlement that arrives a few seconds late — the merchant wouldn't know
    // the customer paid.  Instead, show a "still processing" screen and keep
    // polling for up to PAYMENT_GRACE_MS (90 s) before giving up.
    if (millis() - invoiceCreateTime > INVOICE_TIMEOUT_MS) {
        if (lnurlCallbackSent && !paymentInFlightAtTimeout) {
            paymentInFlightAtTimeout = true;
            invoiceTimeoutAt         = millis();
            DBG_PRINTLN("Invoice timed out but callback sent — entering grace period");
            PinScreen::drawProcessing(tft, "Payment", "still processing...");
        }
        if (paymentInFlightAtTimeout) {
            if (millis() - invoiceTimeoutAt > PAYMENT_GRACE_MS) {
                DBG_PRINTLN("Grace period expired — payment status unknown");
                lastError = "Payment may still be processing - check dashboard";
                ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Payment timeout");
                state = STATE_ERROR;
                return;
            }
            // Continue polling during grace period (polling code below)
        } else {
            // No callback was sent — safe to return to idle immediately.
            enterIdleAmount();
            return;
        }
    }

    // Cancel button (only available while waiting; hidden once callback sent)
    int tx, ty;
    if (!lnurlCallbackSent && readTouch(tx, ty)) {
        if (PaymentScreen::handleTouch(tx, ty)) {
            enterIdleAmount();
            return;
        }
    }

    // Animate the appropriate waiting screen.
    // After a PIN callback the QR is replaced by the confirming screen so the
    // cashier never sees the payment screen a second time.
    if (lnurlCallbackSent) {
        PinScreen::updateConfirming(tft);
    } else {
        PaymentScreen::update(tft);
    }

    // Poll invoice status every 2 s — the authoritative settlement signal.
    // This is the only path to STATE_SUCCESS; no shortcut after callback.
    // The HTTPS status check is a blocking call (TLS handshake can take ~1-3 s on
    // the dev URL). Measure the interval from poll END (not start) so the loop
    // gets ~2 s of fast (~300 ms) iterations between polls where the countdown can
    // tick every second, then refresh the timer the instant the poll returns —
    // otherwise update() runs only once per slow iteration and the timer skips.
    if (millis() - lastStatusPoll >= currentPollInterval) {
        String status = BitposClient::pollInvoiceStatus(currentInvoice.paymentHash);
        if (status == "paid") {
            ResultScreen::draw(tft, RESULT_SUCCESS, currentAmountSats);
            state = STATE_SUCCESS;
            return;
        }
        if (status == "expired") {
            enterIdleAmount();
            return;
        }
        if (status == "error") {
            if (++pollFailCount >= 5) {
                lastError = "Network error - reset to retry";
                ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Network error");
                state = STATE_ERROR;
                return;
            }
            // Exponential back-off: double the poll interval, cap at 30 s
            currentPollInterval = min((uint32_t)30000, currentPollInterval * 2);
        } else {
            // Server responded — reset failure streak and interval
            pollFailCount       = 0;
            currentPollInterval = POLL_INTERVAL_MS;
        }
        lastStatusPoll = millis();   // restart window from poll completion
        if (!lnurlCallbackSent) PaymentScreen::update(tft);  // QR countdown refresh
    }

    // Skip NFC once the LNURL callback has been accepted — avoid re-tapping
    if (lnurlCallbackSent) return;

    // Phase 1 — detect card (300ms RF window, non-blocking to outer loop)
    String nfcUid;
    if (!NfcReader::detectCard(nfcUid)) return;

    // Card in field — start continuous beep so user knows to hold the card
    Buzzer::startBeep();
    PaymentScreen::showCardDetected(tft);
    currentCardUid = nfcUid;

    // Phase 2 — read NDEF URL via ISO-DEP APDU (~300ms, card must stay still)
    String nfcUrl = NfcReader::readNdef();
    Buzzer::stopBeep();  // card read done — cut the beep

    if (nfcUrl.isEmpty()) {
        lastError = "Card read failed - hold flat and try again";
        ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Card read failed");
        state = STATE_ERROR;
        return;
    }

    // Fetch LNURL-withdraw from the card's URL (no device token sent)
    String lnErr;
    auto lw = BitposClient::fetchLnurl(nfcUrl, lnErr);
    if (!lnErr.isEmpty()) {
        lastError = lnErr;
        ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Card error");
        state = STATE_ERROR;
        return;
    }

    // Validate amount fits within the card's withdrawal limit
    long maxSats = lw.maxWithdrawable / 1000; // msats → sats
    if (currentAmountSats > maxSats) {
        lastError = "Amount exceeds card limit";
        ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Exceeds limit");
        state = STATE_ERROR;
        return;
    }

    // Store callback and k1 as separate values — never reconstruct from a URL
    lnurlCallback = lw.callback;
    lnurlK1       = lw.k1;

    // LUD-21: require PIN when pinLimitMsats is present AND amount >= threshold.
    // Mirrors web POS: pinNeeded = (pinLimit !== undefined) && amountSats*1000 >= pinLimit
    bool needPin = (lw.pinLimitMsats >= 0) && (currentAmountSats * 1000 >= lw.pinLimitMsats);
    if (needPin) {
        PinScreen::draw(tft, nfcUid);
        state = STATE_PIN_ENTRY;
        return;
    }

    // No PIN — call callback immediately (third-party host, no device token).
    // Show a processing animation (no mention of PIN) so the customer sees
    // immediate feedback: card tap → dots spin → confirming screen → settled.
    PinScreen::drawProcessing(tft, "Processing", "payment...");

    // Reset the watchdog before the second blocking TLS call in this iteration.
    // fetchLnurl() above was TLS call #1 (up to 10 s); callLnurlCallback() is
    // TLS call #2 (up to 10 s). Without this reset the combined ~20 s could
    // exceed the 30 s WDT window on a slow network connection.
    esp_task_wdt_reset();

    String cbErr = BitposClient::callLnurlCallback(
        lnurlCallback, lnurlK1, currentInvoice.bolt11);

    if (cbErr.isEmpty()) {
        // Callback accepted — show confirming animation and keep polling until settled.
        // Mirrors the PIN path: QR is never shown again after card tap.
        lnurlCallbackSent = true;
        PinScreen::drawConfirming(tft);
    } else {
        lastError = cbErr;
        ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Payment failed");
        state = STATE_ERROR;
    }
}

static void handlePinEntry() {
    PinScreen::update(tft);

    int tx, ty;
    if (!readTouch(tx, ty)) return;

    char action = PinScreen::handleTouch(tft, tx, ty);
    if (action == 'C') {
        // Cancel — return to WAITING_PAYMENT; NFC polling resumes
        lnurlCallback = "";
        lnurlK1       = "";
        PaymentScreen::draw(tft, currentInvoice.bolt11, currentAmountSats, AmountScreen::fiatLabel(), INVOICE_TIMEOUT_MS / 1000);
        state = STATE_WAITING_PAYMENT;
        return;
    }
    if (action == 'O') {
        // Show processing animation — blocks ~1-4 s while the HTTP call runs
        PinScreen::drawProcessing(tft);

        String cbErr = BitposClient::callLnurlCallback(
            lnurlCallback, lnurlK1, currentInvoice.bolt11, PinScreen::getPin());

        if (cbErr.isEmpty()) {
            // Callback accepted — keep polling until invoice settles.
            // Draw the confirming screen instead of the QR payment screen so
            // the cashier never sees the QR a second time after entering the PIN.
            lnurlCallbackSent = true;
            PinScreen::drawConfirming(tft);
            state = STATE_WAITING_PAYMENT;
        } else if (cbErr.indexOf("wrong") >= 0 || cbErr.indexOf("PIN") >= 0 ||
                   cbErr.indexOf("pin") >= 0) {
            // Wrong PIN — redraw the PIN screen (processing screen replaced it), then shake
            PinScreen::draw(tft, currentCardUid);
            PinScreen::setWrongPin(tft);
        } else {
            lastError = cbErr;
            ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Payment failed");
            state = STATE_ERROR;
        }
    }
}

static void handleSuccess() {
    if (ResultScreen::shouldAutoDismiss()) {
        // Reset send mode when returning to idle after a successful send
        if (AmountScreen::isSendMode()) {
            AmountScreen::setSendMode(false);
        }
        enterIdleAmount();
    }
}

static void handleError() {
    int tx, ty;
    if (!readTouch(tx, ty)) return;
    if (ResultScreen::handleTouch(tx, ty)) {
        if (paymentInterruptedByWifi) {
            paymentInterruptedByWifi = false;
            enterConnectingWifi();
        } else {
            // Reset send mode when returning to idle after an error
            if (AmountScreen::isSendMode()) {
                AmountScreen::setSendMode(false);
            }
            enterIdleAmount();
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Send mode — merchant sends sats outward (LNURL-W QR + NFC card tap)
// ──────────────────────────────────────────────────────────────────────────────

// State for the send flow
static String sendLnurlw;    // LNURL-W string for QR display
static String sendK1;        // k1 challenge for status polling
static String sendCardUrl;   // card URL captured from NFC tap
static String sendPin;       // merchant PIN captured at entry, used for send-to-card
static bool  sendQrShown = false;

static void handleSendPinEntry() {
    PinScreen::update(tft);

    int tx, ty;
    if (!readTouch(tx, ty)) return;

    char action = PinScreen::handleTouch(tft, tx, ty);
    if (action == 'C') {
        // Cancel — return to amount screen (stay in send mode)
        enterIdleAmount();
        return;
    }
    if (action == 'O') {
        // PIN entered — show processing, create withdraw
        PinScreen::drawProcessing(tft, "Creating", "withdraw...");

        String pin = PinScreen::getPin();
        sendPin = pin;  // save for send-to-card NFC path
        String err;
        String k1;
        String lnurlw = BitposClient::createWithdraw(currentAmountSats, pin, err, k1);

        if (!err.isEmpty() || lnurlw.isEmpty()) {
            lastError = err.isEmpty() ? "Failed to create withdrawal" : err;
            ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Send failed");
            state = STATE_ERROR;
            return;
        }

        sendLnurlw = lnurlw;
        sendK1 = k1;  // save for status polling
        lastStatusPoll = 0;  // reset poll timer
        sendQrShown = false;
        sendCardUrl = "";

        // Show QR + NFC hint screen
        // Reuse PaymentScreen layout: amount header + QR + "Tap a Bolt Card"
        String fiatLabel = AmountScreen::fiatLabel();
        invoiceCreateTime = millis();
        tft.fillScreen(COL_BG);
        PaymentScreen::draw(tft, sendLnurlw, currentAmountSats, fiatLabel,
                           INVOICE_TIMEOUT_MS / 1000);
        state = STATE_SEND_WAITING;
    }
}

static void handleSendWaiting() {
    // Timeout — return to idle
    if (millis() - invoiceCreateTime > INVOICE_TIMEOUT_MS) {
        AmountScreen::setSendMode(false);
        enterIdleAmount();
        return;
    }

    // Cancel button
    int tx, ty;
    if (readTouch(tx, ty)) {
        if (PaymentScreen::handleTouch(tx, ty)) {
            AmountScreen::setSendMode(false);
            enterIdleAmount();
            return;
        }
    }

    // Animate NFC hint
    PaymentScreen::update(tft);

    // Poll withdrawal status — if the QR was scanned and claimed, show success.
    // Same poll interval as invoice status (2s, growing with backoff).
    if (millis() - lastStatusPoll >= currentPollInterval) {
        String status = BitposClient::pollWithdrawStatus(sendK1);
        if (status == "paid") {
            ResultScreen::draw(tft, RESULT_SUCCESS, currentAmountSats, "", true);
            state = STATE_SUCCESS;
            return;
        }
        if (status == "expired") {
            AmountScreen::setSendMode(false);
            enterIdleAmount();
            return;
        }
        // "error" or "pending" — keep waiting, reset backoff on good response
        if (status == "error") {
            currentPollInterval = min((uint32_t)30000, currentPollInterval * 2);
        } else {
            currentPollInterval = POLL_INTERVAL_MS;
        }
        lastStatusPoll = millis();
    }

    // NFC polling — if a bitPOS card taps, send payment to card holder
    String nfcUid;
    if (!NfcReader::detectCard(nfcUid)) return;

    Buzzer::startBeep();
    PaymentScreen::showCardDetected(tft);

    String nfcUrl = NfcReader::readNdef();
    Buzzer::stopBeep();
    if (nfcUrl.isEmpty()) {
        lastError = "Card read failed - hold flat and try again";
        ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Card read failed");
        state = STATE_ERROR;
        return;
    }

    // Send to card — server verifies card and pays the card holder
    PinScreen::drawProcessing(tft, "Sending", "to card...");

    esp_task_wdt_reset();  // NFC + TLS can take time

    String err;
    BitposClient::sendToCard(nfcUrl, currentAmountSats, sendPin, err);

    if (err.isEmpty()) {
        ResultScreen::draw(tft, RESULT_SUCCESS, currentAmountSats, "", true);
        state = STATE_SUCCESS;
    } else {
        lastError = err;
        ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Send failed");
        state = STATE_ERROR;
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Settings menu + card provisioning
// ──────────────────────────────────────────────────────────────────────────────

// Draw a standard Back button in the top-right corner of a screen.
static void drawBackButton() {
    tft.fillRoundRect(SCREEN_W - 60, 2, 52, 24, 6, COL_CARD);
    tft.drawRoundRect(SCREEN_W - 60, 2, 52, 24, 6, COL_BORDER);
    tft.setTextColor(COL_MUTED, COL_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.setTextFont(FONT_SMALL);
    tft.drawString("Back", SCREEN_W - 34, 14);
}

// Check if the Back button (top-right) was tapped. Returns true if tapped.
static bool isBackButtonTapped(int tx, int ty) {
    return (tx >= SCREEN_W - 60 && tx < SCREEN_W - 8 && ty >= 2 && ty < 26);
}

static void drawUpdateScreen() {
    ledcWrite(0,255);tft.fillScreen(COL_BG);drawBackButton();
    tft.setTextDatum(TL_DATUM);tft.setTextFont(FONT_SMALL);tft.setTextColor(COL_TEXT,COL_BG);
    tft.drawString("Firmware & Updates",12,8);
    tft.drawString(String("Installed: v")+FIRMWARE_VERSION,16,50);
    tft.setTextColor(COL_MUTED,COL_BG);
    tft.drawString(Config::serverUrl.indexOf("dev.openln.com")>=0?"Server: dev.openln.com":"Server: openln.com",16,78);
    tft.drawString(OTAManager::lastStatus(),16,106);
    tft.drawString(OTAManager::lastCode(),16,130);
    tft.fillRoundRect(16,170,SCREEN_W-32,46,8,COL_ACCENT);tft.setTextColor(COL_ON_ACCENT,COL_ACCENT);tft.setTextDatum(MC_DATUM);
    tft.drawString("Check for updates",SCREEN_W/2,193);
}
static void handleUpdateScreen() {
    int tx,ty;if(!readTouch(tx,ty))return;
    if(isBackButtonTapped(tx,ty)){state=STATE_SETTINGS_MENU;SettingsMenu::draw(tft);return;}
    if(tx>=16 && tx<SCREEN_W-16 && ty>=170 && ty<216){
        OTAManager::checkAndUpdate(tft,true);drawUpdateScreen();
    }
}

// Card write callback — updates the screen with each step
static void cardWriteStep(const char* label, bool done) {
    tft.fillScreen(COL_BG);
    tft.setTextDatum(MC_DATUM);
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(done ? COL_SUCCESS : COL_ACCENT, COL_BG);
    tft.drawString(label, SCREEN_W / 2, SCREEN_H / 2 - 20);
    if (!done) {
        tft.setTextFont(FONT_SMALL);
        tft.setTextColor(COL_MUTED, COL_BG);
        tft.drawString("...", SCREEN_W / 2, SCREEN_H / 2 + 20);
    }
    esp_task_wdt_reset();
}

static ProvisionData g_provData;
static WipeData g_wipeData;
static bool g_provDataReady = false;
static bool cardReadDone = false;

static void handleSettingsMenu() {
    int tx, ty;
    if (!readTouch(tx, ty)) return;

    int sel = SettingsMenu::handleTouch(tx, ty);
    if (sel < 0) return;

    switch (sel) {
        case SETTINGS_UPDATES:
            state=STATE_UPDATES;drawUpdateScreen();break;
        case 0: // Back
            enterIdleAmount();
            break;
        case 1: // WiFi
            enterWifiSetup();
            break;
        case 2: // Issue Card
            {
                screenOff = false;
                ledcWrite(0, 255);
                tft.fillScreen(COL_BG);
                drawBackButton();
                tft.setTextDatum(MC_DATUM);
                tft.setTextFont(FONT_SMALL);
                tft.setTextColor(COL_TEXT, COL_BG);
                tft.drawString("Issue Card", SCREEN_W / 2, 40);
                tft.setTextFont(FONT_SMALL);
                tft.setTextColor(COL_MUTED, COL_BG);
                tft.drawString("Fetching card data...", SCREEN_W / 2, 80);

                String err;
                if (BitposClient::fetchNextProvision(g_provData, err)) {
                    g_provDataReady = true;
                    state = STATE_CARD_WRITE;
                    tft.fillScreen(COL_BG);
                    drawBackButton();
                    tft.setTextDatum(MC_DATUM);
                    tft.setTextFont(FONT_SMALL);
                    tft.setTextColor(COL_SUCCESS, COL_BG);
                    tft.drawString("Tap blank card", SCREEN_W / 2, 50);
                    tft.setTextFont(FONT_SMALL);
                    tft.setTextColor(COL_MUTED, COL_BG);
                    tft.drawString("Hold flat and steady", SCREEN_W / 2, 80);
                } else {
                    lastError = "Create a card on openln.com first";
                    ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "No cards to write");
                    state = STATE_ERROR;
                }
            }
            break;
        case 3: // Wipe Card
            state = STATE_CARD_WIPE;
            screenOff = false;
            ledcWrite(0, 255);
            tft.fillScreen(COL_BG);
            drawBackButton();
            tft.setTextDatum(MC_DATUM);
            tft.setTextFont(FONT_SMALL);
            tft.setTextColor(COL_ERROR, COL_BG);
            tft.drawString("Wipe Card", SCREEN_W / 2, 40);
            tft.setTextFont(FONT_SMALL);
            tft.setTextColor(COL_MUTED, COL_BG);
            tft.drawString("Tap the card to wipe", SCREEN_W / 2, 80);
            break;
        case 4: // Read Card
            state = STATE_CARD_READ;
            cardReadDone = false;
            screenOff = false;
            ledcWrite(0, 255);
            tft.fillScreen(COL_BG);
            drawBackButton();
            tft.setTextDatum(MC_DATUM);
            tft.setTextFont(FONT_SMALL);
            tft.setTextColor(COL_TEXT, COL_BG);
            tft.drawString("Read Card", SCREEN_W / 2, 40);
            tft.setTextFont(FONT_SMALL);
            tft.setTextColor(COL_MUTED, COL_BG);
            tft.drawString("Tap any card", SCREEN_W / 2, 80);
            break;
    }
}

static void handleCardWrite() {
    if (!g_provDataReady) return;

    // Check for back button tap
    int tx, ty;
    if (readTouch(tx, ty)) {
        if (isBackButtonTapped(tx, ty)) {
            g_provDataReady = false;
            state = STATE_SETTINGS_MENU;
            SettingsMenu::draw(tft);
            return;
        }
    }

    String nfcUid;
    if (!NfcReader::detectCard(nfcUid)) return;

    Buzzer::playTap();
    g_provDataReady = false;

    esp_task_wdt_reset();

    String err = NfcWriter::writeCard(g_provData, cardWriteStep);
    if (err.isEmpty()) {
        // Mark card as written on server
        String markErr;
        BitposClient::markCardWritten(g_provData.cardId, markErr);
        ResultScreen::draw(tft, RESULT_SUCCESS, 0, "", false, "Payment failed", "Card Issued");
        tft.setTextDatum(TC_DATUM);
        tft.setTextFont(FONT_SMALL);
        tft.setTextColor(COL_SUCCESS, COL_BG);
        tft.drawString("Card issued", SCREEN_W / 2, 160);
        state = STATE_SUCCESS;
    } else {
        lastError = err;
        ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Write failed");
        state = STATE_ERROR;
    }
}

static void handleCardWipe() {
    int tx, ty;
    if (readTouch(tx, ty)) {
        if (isBackButtonTapped(tx, ty)) {
            state = STATE_SETTINGS_MENU;
            SettingsMenu::draw(tft);
            return;
        }
    }

    String nfcUid;
    if (!NfcReader::detectCard(nfcUid)) return;

    Buzzer::playTap();

    // Read NDEF URL to extract cardId
    String nfcUrl = NfcReader::readNdef();
    if (nfcUrl.isEmpty()) {
        lastError = "Card read failed";
        ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Card read failed");
        state = STATE_ERROR;
        return;
    }

    // Extract cardId from URL: .../card/{cardId}?p=...
    int cardStart = nfcUrl.indexOf("/card/");
    if (cardStart < 0) {
        lastError = "Not an openLN card";
        ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Not an openLN card");
        state = STATE_ERROR;
        return;
    }
    cardStart += 6;
    int cardEnd = nfcUrl.indexOf("?", cardStart);
    if (cardEnd < 0) cardEnd = nfcUrl.length();
    String cardId = nfcUrl.substring(cardStart, cardEnd);

    // Fetch wipe keys
    String err;
    if (!BitposClient::fetchWipeKeys(cardId, g_wipeData, err)) {
        lastError = err;
        ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Wipe failed");
        state = STATE_ERROR;
        return;
    }

    // Re-detect the card — readNdef() above called SAMConfig() which cleared
    // the active target. We need the card re-activated for the wipe APDUs.
    delay(200);
    String reUid;
    if (!NfcReader::detectCard(reUid)) {
        lastError = "Card removed — tap again";
        ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Wipe failed");
        state = STATE_ERROR;
        return;
    }

    // Wipe the card
    tft.fillScreen(COL_BG);
    tft.setTextDatum(MC_DATUM);
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_ERROR, COL_BG);
    tft.drawString("Wiping...", SCREEN_W / 2, SCREEN_H / 2);

    esp_task_wdt_reset();

    String wipeErr = NfcWriter::wipeCard(g_wipeData, cardWriteStep);
    if (wipeErr.isEmpty()) {
        String markErr;
        BitposClient::markCardWiped(cardId, markErr);
        ResultScreen::draw(tft, RESULT_SUCCESS, 0, "", false, "Wipe failed", "Card Wiped");
        tft.setTextDatum(TC_DATUM);
        tft.setTextFont(FONT_SMALL);
        tft.setTextColor(COL_SUCCESS, COL_BG);
        tft.drawString("Card wiped", SCREEN_W / 2, 160);
        state = STATE_SUCCESS;
    } else {
        lastError = wipeErr;
        ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Wipe failed");
        state = STATE_ERROR;
    }
}

static void handleCardRead() {
    // After a read, stay on the result screen until Back is tapped
    if (cardReadDone) {
        int tx, ty;
        if (readTouch(tx, ty)) {
            if (isBackButtonTapped(tx, ty)) {
                cardReadDone = false;
                state = STATE_SETTINGS_MENU;
                SettingsMenu::draw(tft);
                return;
            }
        }
        return;
    }

    int tx, ty;
    if (readTouch(tx, ty)) {
        if (isBackButtonTapped(tx, ty)) {
            state = STATE_SETTINGS_MENU;
            SettingsMenu::draw(tft);
            return;
        }
    }

    String nfcUid;
    if (!NfcReader::detectCard(nfcUid)) return;

    Buzzer::playTap();

    String nfcUrl = NfcReader::readNdef();
    cardReadDone = true;  // lock — don't read again until Back is tapped
    tft.fillScreen(COL_BG);
    drawBackButton();

    tft.setTextDatum(TL_DATUM);
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_TEXT, COL_BG);

    if (nfcUrl.isEmpty()) {
        tft.drawString("No NDEF URL found", 10, 40);
    } else {
        tft.setTextColor(COL_MUTED, COL_BG);
        tft.drawString("UID:", 10, 40);
        tft.setTextColor(COL_TEXT, COL_BG);
        tft.drawString(nfcUid, 50, 40);

        tft.setTextColor(COL_MUTED, COL_BG);
        tft.drawString("URL:", 10, 60);
        tft.setTextColor(COL_ACCENT, COL_BG);
        int y = 80;
        for (int i = 0; i < (int)nfcUrl.length(); i += 38) {
            String line = nfcUrl.substring(i, min(i + 38, (int)nfcUrl.length()));
            tft.drawString(line, 10, y);
            y += 16;
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory reset via BOOT button
// ──────────────────────────────────────────────────────────────────────────────
static void checkFactoryReset() {
    static const uint32_t HOLD_MS  = 5000UL;
    static const int      BAR_X    = 20;
    static const int      BAR_Y    = SCREEN_H - 10;
    static const int      BAR_H    = 5;
    static const int      BAR_MAXW = SCREEN_W - 40;
    static bool           barShown = false;

    bool pressed = (digitalRead(BOOT_BTN_PIN) == LOW);
    if (pressed) {
        if (bootBtnPressStart == 0) bootBtnPressStart = millis();

        uint32_t held = millis() - bootBtnPressStart;
        if (held >= HOLD_MS) {
            // Clear bar and flash screen white briefly as confirmation feedback
            tft.fillRect(BAR_X - 2, BAR_Y - 2, BAR_MAXW + 4, BAR_H + 4, COL_BG);
            tft.fillScreen(TFT_WHITE);
            delay(120);
            DBG_PRINTLN("Factory reset triggered (5 s hold)");
            Config::clear();
            ESP.restart();
        }

        // Draw / update progress bar
        int fillW = (int)((float)held / HOLD_MS * BAR_MAXW);
        fillW = min(fillW, BAR_MAXW);
        tft.fillRect(BAR_X, BAR_Y, fillW, BAR_H, COL_ACCENT);
        // Track bar outline on first press so it appears once
        if (!barShown) {
            tft.drawRect(BAR_X - 1, BAR_Y - 1, BAR_MAXW + 2, BAR_H + 2, COL_MUTED);
            barShown = true;
        }
    } else {
        if (barShown) {
            // Erase bar area when released before threshold
            tft.fillRect(BAR_X - 2, BAR_Y - 2, BAR_MAXW + 4, BAR_H + 4, COL_BG);
            barShown = false;
        }
        bootBtnPressStart = 0;
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Loop task stack — must be at file scope (macro expands to a function def)
// Doubles the default 8 KB to 16 KB so mbedTLS has headroom for two
// consecutive TLS handshakes on the no-PIN NFC path without overflowing.
// ──────────────────────────────────────────────────────────────────────────────
SET_LOOP_TASK_STACK_SIZE(16384);

// ──────────────────────────────────────────────────────────────────────────────
// Setup & loop
// ──────────────────────────────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    pinMode(BOOT_BTN_PIN, INPUT_PULLUP);

    // Hardware watchdog — auto-reboot if loop() ever stalls for >30 s.
    // HTTP timeout is 10 s so this only fires on a genuine hang (e.g. stuck TLS).
    esp_task_wdt_init(30, true);   // 30 s timeout, panic=true → reboot
    esp_task_wdt_add(NULL);        // watch the main (loop) task

    // Buzzer — active TMB12A05 on the CYD SPEAK connector (GPIO 26).
    Buzzer::init();

    // TFT backlight — GPIO 21 on CYD via LEDC PWM (full brightness = 255)
    // Using LEDC rather than digitalWrite gives reliable full duty cycle
    // regardless of any TFT_eSPI internal pin state changes.
    ledcSetup(0, 5000, 8);   // channel 0, 5 kHz, 8-bit resolution
    ledcAttachPin(21, 0);    // GPIO 21 → LEDC channel 0
    ledcWrite(0, 255);       // 100% duty cycle → max brightness

    // TFT init — ILI9341_2_DRIVER + USE_HSPI_PORT matches witnessmenow CYD reference.
    // setRotation(1) = landscape, correct orientation on CYD with this driver.
    tft.init();
    tft.setRotation(SCREEN_ROTATION);
    // CYD panel renders colors inverted by default — without this every color
    // shows as its photo-negative (black bg -> white, orange -> blue, etc.).
    tft.invertDisplay(true);
    tft.fillScreen(COL_BG);

    // Touch init — VSPI bus: SCK=25, MISO=39, MOSI=32
    touchSpi.begin(25, 39, 32, 33);
    touch.begin(touchSpi);

    Serial.printf("RIC boot: version=%s board=%s reset=%d\n",FIRMWARE_VERSION,RIC_BOARD,esp_reset_reason());

    // NFC init (non-fatal — device works without NFC)
    NfcReader::begin();

    // Load config from NVS
    Config::load();

    if (Config::isProvisioned()) {
        // Already provisioned — connect to WiFi directly
        enterConnectingWifi();
    } else {
        enterProvisioning();
    }

    // Power-on confirmation beep (plays once loop() starts ticking the buzzer).
    Buzzer::playBoot();
}

void loop() {
    esp_task_wdt_reset();   // feed the watchdog every iteration

    // Buzzer patterns advance on a hardware esp_timer (see Buzzer.cpp), not
    // here — so timing stays accurate even while loop() blocks on TLS.

    // Audible feedback on state transitions — one edge-detect covers every path
    // into SUCCESS/ERROR without touching each transition site individually.
    // The tap beep is fired inline at card detection (see handleWaitingPayment).
    static auto prevState = state;
    if (state != prevState) {
        if (state == STATE_SUCCESS)      Buzzer::playSuccess();
        else if (state == STATE_ERROR)   Buzzer::playError();
        prevState = state;
    }

    // Heap monitor — log free heap every 30 s for serial visibility.
    // Pre-allocated buffers (BitposClient::_respBuf, _urlBuf, Invoice fields)
    // make heap use O(1) after the first transaction; this log lets you verify
    // that in the serial monitor.  No reboot: fixing the root cause is better
    // than masking fragmentation with a scheduled restart.
    {
        static uint32_t lastHeapCheck = 0;
        if (millis() - lastHeapCheck > 30000) {
            lastHeapCheck = millis();
            DBG_PRINTF("Heap: %u bytes free (largest block: %u)\n",
                          ESP.getFreeHeap(), ESP.getMaxAllocHeap());
        }
    }

    // ── WiFi watchdog ──────────────────────────────────────────────────────
    // If the connection drops in any operational state, give the ESP32's
    // auto-reconnect 5 s to recover on its own, then force a full reconnect.
    if (state != STATE_PROVISIONING && state != STATE_CONNECTING_WIFI &&
        state != STATE_WIFI_SETUP && state != STATE_UPDATES && state != STATE_SEND_WAITING &&
        state != STATE_CARD_WRITE && state != STATE_CARD_WIPE &&
        state != STATE_CARD_READ && state != STATE_SETTINGS_MENU) {
        if (WiFi.status() != WL_CONNECTED) {
            if (wifiLostAt == 0) {
                wifiLostAt = millis();
                DBG_PRINTLN("WiFi lost — waiting for auto-reconnect...");
            } else if (millis() - wifiLostAt > 5000) {
                if (state == STATE_WAITING_PAYMENT || state == STATE_PIN_ENTRY) {
                    // WiFi dropped during a live transaction — don't silently abandon.
                    // Show a clear warning so the cashier knows to check the dashboard.
                    DBG_PRINTLN("WiFi lost during payment — showing warning");
                    paymentInterruptedByWifi = true;
                    lastError = "WiFi lost — check dashboard if payment completed";
                    ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Server error");
                    state = STATE_ERROR;
                } else {
                    DBG_PRINTLN("WiFi still down after 5 s — reconnecting");
                    enterConnectingWifi();
                }
                wifiLostAt = 0;
                return;
            }
        } else {
            if (wifiLostAt != 0) {
                DBG_PRINTLN("WiFi restored");
                wifiLostAt = 0;
            }
        }
    }

    checkFactoryReset();

    // Price refresh when connected.
    // Two retry intervals:
    //   - price = 0 (unknown): retry every 30 s so a boot-time fetch failure
    //     self-heals quickly without hammering the server.
    //   - price > 0 (known): refresh every 5 min (PRICE_TTL_MS).
    if (state == STATE_IDLE_AMOUNT) {
        // Management only when idle with no entered amount. Never during payments
        // or NFC write/wipe, and use jitter to avoid a fleet reconnect storm.
        if(RicPolicy::managementAllowed(true,AmountScreen::hasInput(),paymentInFlightAtTimeout || paymentInterruptedByWifi) && WiFi.status()==WL_CONNECTED){
            if(millis()-lastHelloAt>300000){
                auto result=DeviceLink::hello();lastHelloAt=millis();
                serverAuthenticated=result==RicPolicy::AuthState::Accepted;
                if(!serverAuthenticated){enterConnectingWifi();return;}
            }
            if(nextOtaCheck && RicPolicy::due(millis(),nextOtaCheck)){
                OTAManager::checkAndUpdate(tft);nextOtaCheck=millis()+900000+(esp_random()%60000);
                enterIdleAmount();return;
            }
        }
        bool priceUnknown = (satsPerUnit <= 0);
        uint32_t interval = priceUnknown ? PRICE_RETRY_MS : PRICE_TTL_MS;
        if (millis() - priceLastFetched > interval) {
            float fresh = BitposClient::fetchPrice(Config::currency);
            if (fresh > 0) {
                satsPerUnit      = fresh;
                AmountScreen::setPrice(effectiveSatsPerUnit(), Config::currency);
                AmountScreen::updateAmountDisplay(tft);
            }
            // ALWAYS update the timestamp after an attempt — success or failure.
            // The old code only updated priceLastFetched on success or when price
            // was unknown, so a failed refresh of a KNOWN price left the timestamp
            // stale and the condition true every loop → fetchPrice (a blocking TLS
            // call) was invoked every 50 ms, self-DDoSing the API server.  With
            // 200 devices this would be a sustained 4000 req/s against /api/price.
            priceLastFetched = millis();
        }
    }

    // Health dot — reflect live connectivity + price freshness while idle.
    // Also uses the same 2 s tick to attempt NFC reinit if the reader was lost.
    if (state == STATE_IDLE_AMOUNT) {
        static uint32_t lastStatusTick = 0;
        if (millis() - lastStatusTick > 2000) {
            lastStatusTick = millis();
            bool online = (WiFi.status() == WL_CONNECTED) && serverAuthenticated;
            bool stale  = (priceLastFetched == 0) ||
                          (millis() - priceLastFetched > PRICE_TTL_MS);
            AmountScreen::setStatus(online, stale);
            AmountScreen::updateHeader(tft); // repaints only on actual change

            // NFC self-healing — if the PN532 was lost (loose wire, I2C glitch),
            // try to reinitialise every 2 s while idle.  No-op if already ready.
            NfcReader::reinit();
        }
    }

    // Screen sleep — kill backlight after SCREEN_DIM_MS of no touch while idle.
    // The display panel and touch controller stay powered; the next touch wakes
    // it instantly and is consumed (doesn't register as a digit press).
    // Skip when screen is already off to avoid redundant ledcWrite calls.
    if (state == STATE_IDLE_AMOUNT && !screenOff &&
        millis() - lastActivityMs > SCREEN_DIM_MS) {
        screenOff = true;
        ledcWrite(0, 0);    // backlight off
    }

    switch (state) {
        case STATE_UPDATES:
            handleUpdateScreen();
            break;
        case STATE_PROVISIONING:
            ProvisionScreen::update(tft);
            if (ProvisionService::isComplete()) {
                Config::save(ProvisionService::ssid, ProvisionService::pass,
                             ProvisionService::token, ProvisionService::serverUrl,
                             ProvisionService::currency);
                enterConnectingWifi();
            }
            break;

        case STATE_CONNECTING_WIFI:
            handleConnectingWifi();
            break;

        case STATE_IDLE_AMOUNT:
            handleIdleAmount();
            break;

        case STATE_CREATING_INVOICE:
            handleCreatingInvoice();
            break;

        case STATE_WAITING_PAYMENT:
            handleWaitingPayment();
            break;

        case STATE_PIN_ENTRY:
            handlePinEntry();
            break;

        case STATE_SUCCESS:
            handleSuccess();
            break;

        case STATE_ERROR:
            handleError();
            break;

        case STATE_WIFI_SETUP:
            handleWifiSetup();
            break;

        case STATE_SEND_PIN_ENTRY:
            handleSendPinEntry();
            break;

        case STATE_SEND_WAITING:
            handleSendWaiting();
            break;

        case STATE_SETTINGS_MENU:
            handleSettingsMenu();
            break;

        case STATE_CARD_WRITE:
            handleCardWrite();
            break;

        case STATE_CARD_WIPE:
            handleCardWipe();
            break;

        case STATE_CARD_READ:
            handleCardRead();
            break;
    }

    delay(50); // ~20 Hz loop — enough for touch responsiveness
}
