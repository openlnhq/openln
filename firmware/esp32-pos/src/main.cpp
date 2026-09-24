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
#include "core/InvoiceTtl.h"
#include <time.h>

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
// Set once the server reports the hold accepted/forwarding: the sale is
// committed and no further card reads happen on this invoice.
static bool holdCommitted     = false;

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
// Checkout presentation window, per invoice, derived from the server's real
// expiry (`expiresAt` on the create response — 15 min for the wrapped hold,
// 60 min on the direct lanes). See InvoiceTtl.h; fallback 360 s when the
// field is missing/unparseable. Set on every invoice/withdraw creation.
static uint32_t invoiceTtlMs = InvoiceTtl::FALLBACK_SECONDS * 1000U; // receive QR
static uint32_t sendTtlMs    = InvoiceTtl::FALLBACK_SECONDS * 1000U; // send QR (LNURL-W)
static uint32_t lastStatusPoll = 0;
static const uint32_t POLL_INTERVAL_MS = 2000;
static int      pollFailCount      = 0;      // consecutive HTTP errors; resets on good response
static uint32_t currentPollInterval = POLL_INTERVAL_MS; // grows with exponential back-off

// There is deliberately NO grace period / give-up timer once a card callback
// may have been dispatched: the device polls the invoice until the server
// reports paid, expired or cancelled. See handleWaitingPayment().

// WiFi watchdog — reconnect if connection lost for >5 s in any operational state
static uint32_t wifiConnectStart        = 0;
static uint32_t wifiLostAt             = 0;

// Card callback dispatch bookkeeping (see dispatchCardPayment).
static uint32_t callbackRetryAt   = 0;   // non-zero: a NotSent callback is scheduled to retry
static int      callbackAttempts  = 0;   // connect attempts for the current tap
static String   pendingCallbackPin;      // PIN to reuse on the deferred retry
static uint32_t nfcRetryHintAt    = 0;   // when "tap again" was shown (hint auto-clears)
static const int CALLBACK_CONNECT_RETRIES = 3;
static void dispatchCardPayment(const String& pin);
static void enterCreatingInvoice();
static void drawCreatingInvoice(bool retrying);

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
static void enterIdleAmountKeepAmount();
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

    // Radio settings for a payment terminal on a weak 2.4 GHz link:
    //  - no modem power-save: PS mode adds 100-300 ms latency spikes and is the
    //    usual cause of TLS handshakes timing out on marginal RSSI.
    //  - explicit STA mode + persistent off: we manage credentials in NVS.
    WiFi.persistent(false);
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.setAutoReconnect(true);
    WiFi.begin(Config::ssid.c_str(), Config::pass.c_str());
}

static void handleConnectingWifi() {
    wl_status_t s = WiFi.status();
    if (s == WL_CONNECTED) {
        Serial.printf("RIC wifi: connected ip=%s rssi=%d ch=%d\n",
                      WiFi.localIP().toString().c_str(), WiFi.RSSI(), WiFi.channel());

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

// Same, but the typed amount survives (used after a rejected send PIN).
static void enterIdleAmountKeepAmount() {
    screenOff      = false;
    lastActivityMs = millis();
    ledcWrite(0, 255);
    AmountScreen::cancelPayHold();
    AmountScreen::draw(tft, true);
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

    // Currency chip (top-right) — flip between typing fiat and typing sats.
    if (AmountScreen::isCurrencyTap(tx, ty)) {
        AmountScreen::toggleSatsMode(tft);
        Buzzer::playTap();
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
            enterCreatingInvoice();
        }
    }
}

// Invoice creation retries. A flaky uplink or a slow wallet RPC must not
// end the sale: keep asking for the SAME amount with backoff until the server
// answers or the cashier cancels. No invoice exists until the server says so,
// so repeating this request can never double-charge anyone.
static uint32_t createAttemptAt   = 0;   // millis() when the next attempt may run
static uint32_t createBackoffMs   = 0;   // 0 on first attempt, then 1.5s, 3s, 6s ... capped
static int      createAttempts    = 0;
static const uint32_t CREATE_BACKOFF_MAX_MS = 8000;
static void drawCreatingInvoice(bool retrying);

static void handleCreatingInvoice() {
    // Cancel: the cashier can always bail out while nothing exists yet.
    int tx, ty;
    if (readTouch(tx, ty) && PaymentScreen::handleTouch(tx, ty)) {
        enterIdleAmount();
        return;
    }
    if (createAttemptAt && !RicPolicy::due(millis(), createAttemptAt)) {
        PinScreen::updateConfirming(tft);   // keep the dots moving while we wait
        return;
    }

    createAttempts++;
    String err; bool transient = false;
    esp_task_wdt_reset();
    currentInvoice = BitposClient::createInvoice(currentAmountSats, err, transient);

    if (!err.isEmpty() || currentInvoice.bolt11.isEmpty()) {
        if (transient || err.isEmpty()) {
            // Network / wallet hiccup: same amount, try again after a pause.
            createBackoffMs = createBackoffMs ? std::min(createBackoffMs * 2, CREATE_BACKOFF_MAX_MS) : 1500;
            createAttemptAt = millis() + createBackoffMs;
            Serial.printf("RIC invoice: retry %d in %lums (%s) heap=%u\n",
                          createAttempts, (unsigned long)createBackoffMs, err.c_str(), ESP.getFreeHeap());
            drawCreatingInvoice(true);
            return;
        }
        // The server answered with a real rejection (e.g. wallet not
        // configured). Retrying would not change the answer: show it.
        lastError = err;
        ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Invoice failed");
        state = STATE_ERROR;
        return;
    }

    invoiceCreateTime   = millis();
    invoiceTtlMs        = InvoiceTtl::secondsUntil(currentInvoice.expiresAt.c_str(), (int64_t)time(nullptr)) * 1000U;
    Serial.printf("RIC invoice: ttl=%us hash=%.12s\n", (unsigned)(invoiceTtlMs / 1000U), currentInvoice.paymentHash.c_str());
    lastStatusPoll      = 0;
    pollFailCount       = 0;
    currentPollInterval = POLL_INTERVAL_MS;
    lnurlCallbackSent   = false;
    holdCommitted       = false;
    lnurlCallback       = "";
    lnurlK1             = "";
    callbackRetryAt          = 0;
    callbackAttempts         = 0;
    PaymentScreen::draw(tft, currentInvoice.bolt11, currentAmountSats, AmountScreen::fiatLabel(), static_cast<int>(invoiceTtlMs / 1000U));
    state = STATE_WAITING_PAYMENT;
}

// "Creating invoice" screen: same visual language as the confirming screen,
// plus a Cancel button in the PaymentScreen's cancel zone so hit-testing is
// shared. `retrying` swaps the subtitle so the cashier knows the link is slow,
// not dead.
static void drawCreatingInvoice(bool retrying) {
    PinScreen::drawProcessing(tft, "Creating", retrying ? "invoice, retrying..." : "invoice...");
    PaymentScreen::drawCancelButton(tft);
}

static void enterCreatingInvoice() {
    state = STATE_CREATING_INVOICE;
    createAttemptAt = 0; createBackoffMs = 0; createAttempts = 0;
    drawCreatingInvoice(false);
}

// ── Card tap: one attempt to dispatch the payment for the CURRENT invoice ──
// Shared by the no-PIN path (called right after the NDEF read) and the PIN
// path. Never creates a new invoice. Returns to the waiting screen on any
// outcome that leaves the invoice unpaid and undispatched, so the customer can
// simply tap again. Only an ACCEPTED or AMBIGUOUS dispatch moves the flow to
// "Confirming", and from there only the invoice status decides.
static void dispatchCardPayment(const String& pin) {
    esp_task_wdt_reset();
    String detail;
    callbackAttempts++;
    auto outcome = BitposClient::callLnurlCallback(lnurlCallback, lnurlK1, currentInvoice.bolt11, pin, detail);
    Serial.printf("RIC callback: attempt=%d outcome=%d detail=%s heap=%u largest=%u\n",
                  callbackAttempts, (int)outcome, detail.c_str(), ESP.getFreeHeap(), ESP.getMaxAllocHeap());

    switch (outcome) {
        case BitposClient::CallbackOutcome::Accepted:
        case BitposClient::CallbackOutcome::Ambiguous:
            // Either the wallet was asked to pay, or we cannot rule it out. From
            // here the only truth is the invoice status: keep polling, hide the
            // QR, and never let the customer tap this invoice again.
            lnurlCallbackSent = true;
            lastStatusPoll    = 0;               // poll immediately
            currentPollInterval = POLL_INTERVAL_MS;
            PinScreen::drawConfirming(tft);
            state = STATE_WAITING_PAYMENT;
            return;

        case BitposClient::CallbackOutcome::NotSent:
            // The request never left the device (TLS/TCP/DNS). Nothing happened
            // on the server. Retry the identical request a few times while the
            // customer keeps the card on the reader, then fall back to waiting.
            if (callbackAttempts < CALLBACK_CONNECT_RETRIES) {
                PinScreen::drawProcessing(tft, "Connecting", "retrying...");
                callbackRetryAt = millis() + 800;
                pendingCallbackPin = pin;
                state = STATE_WAITING_PAYMENT;
                return;
            }
            lnurlCallback = ""; lnurlK1 = "";
            callbackAttempts = 0;
            PaymentScreen::draw(tft, currentInvoice.bolt11, currentAmountSats, AmountScreen::fiatLabel(), static_cast<int>(invoiceTtlMs / 1000U));
            PaymentScreen::setStage(tft, "No connection. Tap again");
            nfcRetryHintAt = millis();
            state = STATE_WAITING_PAYMENT;
            return;

        case BitposClient::CallbackOutcome::Rejected:
            // Definitive server answer: nothing was dispatched. PIN problems go
            // back to the PIN screen; everything else returns to the waiting
            // screen with the reason, same invoice, so the customer can retap
            // or pay the QR instead.
            if (!pin.isEmpty() && (detail.indexOf("PIN") >= 0 || detail.indexOf("pin") >= 0) &&
                detail.indexOf("locked") < 0) {
                PinScreen::draw(tft, currentCardUid);
                PinScreen::setWrongPin(tft);
                state = STATE_PIN_ENTRY;
                return;
            }
            lnurlCallback = ""; lnurlK1 = "";
            callbackAttempts = 0;
            Buzzer::playError();
            PaymentScreen::draw(tft, currentInvoice.bolt11, currentAmountSats, AmountScreen::fiatLabel(), static_cast<int>(invoiceTtlMs / 1000U));
            PaymentScreen::setStage(tft, detail.isEmpty() ? "Card declined" : detail);
            nfcRetryHintAt = millis();
            state = STATE_WAITING_PAYMENT;
            return;
    }
}

static void handleWaitingPayment() {
    const uint32_t now = millis();

    // ── Presentation window ─────────────────────────────────────────────────
    // Before any dispatch the QR/tap screen simply expires back to idle. Once a
    // payment MAY be in flight (callback accepted or ambiguous) there is no
    // timeout at all: the terminal keeps polling this invoice until the server
    // says paid, expired or cancelled. A merchant can always leave via the
    // dashboard; the device never invents a "failed" it cannot prove.
    if (!lnurlCallbackSent && callbackRetryAt == 0 && now - invoiceCreateTime > invoiceTtlMs) {
        const String expired = currentInvoice.paymentHash;
        enterIdleAmount();
        BitposClient::cancelInvoice(expired);
        return;
    }

    // ── Cancel button (only before a dispatch) ──────────────────────────────
    // Screen returns to the amount pad first (instant for the cashier), then
    // the server is told so the hold is closed now rather than at expiry.
    int tx, ty;
    if (!lnurlCallbackSent && callbackRetryAt == 0 && readTouch(tx, ty)) {
        if (PaymentScreen::handleTouch(tx, ty)) {
            const String cancelled = currentInvoice.paymentHash;
            enterIdleAmount();
            BitposClient::cancelInvoice(cancelled);
            return;
        }
    }

    // ── Deferred callback retry (connect failed, card still present) ────────
    if (callbackRetryAt) {
        if (!RicPolicy::due(now, callbackRetryAt)) { PinScreen::updateConfirming(tft); return; }
        callbackRetryAt = 0;
        dispatchCardPayment(pendingCallbackPin);
        pendingCallbackPin = "";
        return;
    }

    // ── Animate ─────────────────────────────────────────────────────────────
    if (lnurlCallbackSent) PinScreen::updateConfirming(tft);
    else {
        PaymentScreen::update(tft);
        // A transient hint ("tap again", a decline reason) reverts to the
        // default prompt after a few seconds so the screen never looks stuck.
        if (nfcRetryHintAt && RicPolicy::elapsed(now, nfcRetryHintAt, 4000)) {
            nfcRetryHintAt = 0;
            PaymentScreen::setStage(tft, "Ready to pay");
        }
    }

    // ── Poll invoice status: the ONLY path to SUCCESS ───────────────────────
    // The interval is measured from poll END so the UI gets ~2 s of fast
    // iterations between blocking HTTPS calls. On "error" (no usable answer)
    // back off up to 15 s and keep going forever: a network error says
    // nothing about the invoice. There is no failure count any more.
    if (now - lastStatusPoll >= currentPollInterval) {
        String status = BitposClient::pollInvoiceStatus(currentInvoice.paymentHash);
        if (status == "paid") {
            ResultScreen::draw(tft, RESULT_SUCCESS, currentAmountSats);
            state = STATE_SUCCESS;
            return;
        }
        if (status == "expired" || status == "cancelled" || status == "unknown") {
            // The server has closed this invoice. If a card was dispatched
            // against it and it did not settle, the customer was not charged
            // (the hold was never accepted); say so instead of a silent reset.
            if (lnurlCallbackSent) {
                lastError = status == "unknown" ? "Invoice no longer exists" : "Payment did not complete";
                ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Not paid");
                state = STATE_ERROR;
                return;
            }
            enterIdleAmount();
            return;
        }
        if (status == "error") {
            pollFailCount++;
            currentPollInterval = std::min((uint32_t)15000, std::max(POLL_INTERVAL_MS, currentPollInterval * 2));
            if (pollFailCount == 3 && lnurlCallbackSent) {
                // Tell the cashier the truth without changing the outcome.
                PinScreen::drawProcessing(tft, "Confirming", "reconnecting...");
            }
        } else {
            // Server answered (pending / accepted / forwarding / forwarded).
            if (pollFailCount >= 3 && lnurlCallbackSent) PinScreen::drawConfirming(tft);
            pollFailCount       = 0;
            currentPollInterval = POLL_INTERVAL_MS;
            // The customer's funds are locked on the hold: the sale is
            // committed, only the merchant forward + settle remain (which can
            // take minutes when the relay is slow). Say so and stop reading
            // cards on this invoice, otherwise a cashier watching a QR that
            // never changes taps again and mints duplicate invoices
            // (2026-09-19 dev: two unpaid 12,285-sat duplicates during a
            // relay outage). The invoice is never abandoned here.
            if (!holdCommitted && (status == "accepted" || status == "forwarding" || status == "forwarded")) {
                holdCommitted = true;
                lnurlCallbackSent = true;   // no second tap against this invoice
                Buzzer::playTap();
                PinScreen::drawProcessing(tft, "Payment received", "finishing up, do not tap again");
                Serial.printf("RIC pay: hold %s hash=%.12s\n", status.c_str(), currentInvoice.paymentHash.c_str());
            }
        }
        lastStatusPoll = millis();   // restart window from poll completion
        if (!lnurlCallbackSent) PaymentScreen::update(tft);  // QR countdown refresh
    }

    // Skip NFC once a callback may have been dispatched — never retap this invoice.
    if (lnurlCallbackSent) return;

    // ── Phase 1: detect card (300 ms RF window, non-blocking to outer loop) ──
    String nfcUid;
    if (!NfcReader::detectCard(nfcUid)) return;

    // Card in field — continuous beep so the customer knows to hold still.
    Buzzer::startBeep();
    PaymentScreen::showCardDetected(tft);
    currentCardUid = nfcUid;

    // ── Phase 2: read NDEF URL via ISO-DEP APDU (~300 ms, card must stay still) ──
    // NfcReader retries with RF power-cycles internally. If it still fails the
    // card moved: stay on THIS invoice and ask for another tap. Never restart
    // the sale over a misread.
    String nfcUrl = NfcReader::readNdef();
    Buzzer::stopBeep();

    if (nfcUrl.isEmpty()) {
        Buzzer::playError();
        PaymentScreen::setStage(tft, "Hold card flat, tap again");
        nfcRetryHintAt = millis();
        return;
    }

    // ── Phase 3: fetch LNURL-withdraw from the card's URL (no device token) ──
    // A transport failure here means nothing was dispatched: same invoice,
    // tap again. A server ERROR is a real decline for this card.
    PaymentScreen::setStage(tft, "Reading card...", false);
    esp_task_wdt_reset();
    String lnErr;
    auto lw = BitposClient::fetchLnurl(nfcUrl, lnErr);
    if (!lnErr.isEmpty()) {
        Buzzer::playError();
        bool transport = lnErr.indexOf("No response") >= 0 || lnErr.indexOf("Invalid JSON") >= 0;
        PaymentScreen::setStage(tft, transport ? "No connection. Tap again" : lnErr);
        nfcRetryHintAt = millis();
        return;
    }

    // Validate amount fits within the card's withdrawal limit
    long maxSats = lw.maxWithdrawable / 1000; // msats → sats
    if (currentAmountSats > maxSats) {
        Buzzer::playError();
        PaymentScreen::setStage(tft, "Exceeds card limit");
        nfcRetryHintAt = millis();
        return;
    }

    // Store callback and k1 as separate values — never reconstruct from a URL
    lnurlCallback = lw.callback;
    lnurlK1       = lw.k1;
    callbackAttempts = 0;

    // LUD-21: require PIN when pinLimitMsats is present AND amount >= threshold.
    bool needPin = (lw.pinLimitMsats >= 0) && (currentAmountSats * 1000 >= lw.pinLimitMsats);
    if (needPin) {
        PinScreen::draw(tft, nfcUid);
        state = STATE_PIN_ENTRY;
        return;
    }

    // No PIN — dispatch immediately. fetchLnurl above was TLS call #1; the
    // callback is TLS call #2, so feed the watchdog in between.
    PinScreen::drawProcessing(tft, "Processing", "payment...");
    dispatchCardPayment("");
}

static void handlePinEntry() {
    PinScreen::update(tft);

    int tx, ty;
    if (!readTouch(tx, ty)) return;

    char action = PinScreen::handleTouch(tft, tx, ty);
    if (action == 'C') {
        // Cancel — return to WAITING_PAYMENT; NFC polling resumes on the same invoice
        lnurlCallback = "";
        lnurlK1       = "";
        PaymentScreen::draw(tft, currentInvoice.bolt11, currentAmountSats, AmountScreen::fiatLabel(), static_cast<int>(invoiceTtlMs / 1000U));
        state = STATE_WAITING_PAYMENT;
        return;
    }
    if (action == 'O') {
        // Show processing animation, then dispatch through the shared path.
        PinScreen::drawProcessing(tft);
        dispatchCardPayment(PinScreen::getPin());
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
        // Reset send mode when returning to idle after an error
        if (AmountScreen::isSendMode()) {
            AmountScreen::setSendMode(false);
        }
        enterIdleAmount();
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
static int    sendPinFailures = 0;  // consecutive wrong send PINs on this pad
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
        String wdExpires;
        String lnurlw = BitposClient::createWithdraw(currentAmountSats, pin, err, k1, wdExpires);

        if (!err.isEmpty() || lnurlw.isEmpty()) {
            // Wrong PIN: shake and let the cashier retry on the same pad. Three
            // strikes returns to the amount screen (amount kept). The server
            // locks the account after 5 fails / 15 min, so this is bounded.
            const bool wrongPin = err.indexOf("Invalid PIN") >= 0 || err.indexOf("PIN required") >= 0;
            if (wrongPin && ++sendPinFailures < 3) {
                Serial.printf("RIC send: wrong PIN attempt %d\n", sendPinFailures);
                PinScreen::draw(tft, "", 6);
                PinScreen::setWrongPin(tft);
                return;
            }
            sendPinFailures = 0;
            if (wrongPin) {
                // Three wrong: back to the amount pad, still in send mode.
                Buzzer::playError();
                enterIdleAmountKeepAmount();
                return;
            }
            lastError = err.isEmpty() ? "Failed to create withdrawal" : err;
            ResultScreen::draw(tft, RESULT_ERROR, 0, lastError, false, "Send failed");
            state = STATE_ERROR;
            return;
        }
        sendPinFailures = 0;

        sendLnurlw = lnurlw;
        sendK1 = k1;  // save for status polling
        lastStatusPoll = 0;  // reset poll timer
        sendQrShown = false;
        sendCardUrl = "";

        // Show QR + NFC hint screen
        // Reuse PaymentScreen layout: amount header + QR + "Tap a Bolt Card"
        String fiatLabel = AmountScreen::fiatLabel();
        invoiceCreateTime = millis();
        sendTtlMs = InvoiceTtl::secondsUntil(wdExpires.c_str(), (int64_t)time(nullptr)) * 1000U;
        Serial.printf("RIC send: ttl=%us\n", (unsigned)(sendTtlMs / 1000U));
        tft.fillScreen(COL_BG);
        PaymentScreen::draw(tft, sendLnurlw, currentAmountSats, fiatLabel,
                           static_cast<int>(sendTtlMs / 1000U));
        PaymentScreen::setStage(tft, "Ready to send");
        state = STATE_SEND_WAITING;
    }
}

static void handleSendWaiting() {
    // Timeout — return to idle
    if (millis() - invoiceCreateTime > sendTtlMs) {
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

    // Animate NFC hint; a transient "tap again" hint reverts after a few seconds.
    PaymentScreen::update(tft);
    if (nfcRetryHintAt && RicPolicy::elapsed(millis(), nfcRetryHintAt, 4000)) {
        nfcRetryHintAt = 0;
        PaymentScreen::setStage(tft, "Ready to send");
    }

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

    // NFC polling — if an openLN card taps, send payment to card holder
    String nfcUid;
    if (!NfcReader::detectCard(nfcUid)) return;

    Buzzer::startBeep();
    PaymentScreen::showCardDetected(tft);

    String nfcUrl = NfcReader::readNdef();
    Buzzer::stopBeep();
    if (nfcUrl.isEmpty()) {
        // Same recovery as the receive path: the card moved before the NDEF
        // read finished. Stay on THIS withdrawal, ask for another tap.
        Buzzer::playError();
        PaymentScreen::setStage(tft, "Hold card flat, tap again");
        nfcRetryHintAt = millis();
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
    // auto-reconnect 5 s to recover on its own, then force a reconnect.
    //
    // During a live transaction (waiting / PIN / confirming) the invoice is
    // NOT abandoned: WiFi loss is a network event, not a payment outcome. The
    // device keeps its invoice context, shows "reconnecting", and the
    // waiting-state poll loop simply resumes when the link is back. If the
    // customer's card was already dispatched, the poll will find "paid".
    if (state != STATE_PROVISIONING && state != STATE_CONNECTING_WIFI &&
        state != STATE_WIFI_SETUP && state != STATE_UPDATES && state != STATE_SEND_WAITING &&
        state != STATE_CARD_WRITE && state != STATE_CARD_WIPE &&
        state != STATE_CARD_READ && state != STATE_SETTINGS_MENU) {
        if (WiFi.status() != WL_CONNECTED) {
            if (wifiLostAt == 0) {
                wifiLostAt = millis();
                Serial.printf("RIC wifi: lost state=%d rssi=%d\n", (int)state, WiFi.RSSI());
                if (state == STATE_WAITING_PAYMENT || state == STATE_CREATING_INVOICE) {
                    // Stop the RF beep if a card read was interrupted; tell the cashier.
                    // (PIN entry keeps its keypad; the dispatch itself reports the link.)
                    Buzzer::stopBeep();
                    if (lnurlCallbackSent || state == STATE_CREATING_INVOICE) PinScreen::drawProcessing(tft, "Reconnecting", "WiFi lost, invoice kept");
                    else PaymentScreen::setStage(tft, "WiFi lost, reconnecting");
                }
            } else if (millis() - wifiLostAt > 5000) {
                if (state == STATE_WAITING_PAYMENT || state == STATE_PIN_ENTRY || state == STATE_CREATING_INVOICE) {
                    // Kick the radio without leaving the transaction. Sockets are
                    // dropped so the next HTTP call starts with a clean handshake.
                    Serial.println("RIC wifi: reconnect in place (payment context kept)");
                    DeviceLink::release();
                    WiFi.disconnect(false);
                    WiFi.begin(Config::ssid.c_str(), Config::pass.c_str());
                    wifiLostAt = millis();          // re-arm: try again in 5 s if still down
                    lastStatusPoll = millis();      // do not poll into a dead socket immediately
                    esp_task_wdt_reset();
                    return;
                }
                DBG_PRINTLN("WiFi still down after 5 s — reconnecting");
                enterConnectingWifi();
                wifiLostAt = 0;
                return;
            }
        } else {
            if (wifiLostAt != 0) {
                Serial.printf("RIC wifi: restored rssi=%d ip=%s\n", WiFi.RSSI(), WiFi.localIP().toString().c_str());
                wifiLostAt = 0;
                if (state == STATE_WAITING_PAYMENT) {
                    // Redraw the right screen for where the transaction is.
                    if (lnurlCallbackSent) PinScreen::drawConfirming(tft);
                    else PaymentScreen::setStage(tft, "Ready to pay");
                    lastStatusPoll = 0;   // poll right away
                    currentPollInterval = POLL_INTERVAL_MS;
                } else if (state == STATE_CREATING_INVOICE) {
                    createAttemptAt = 0;  // retry the invoice request now
                    drawCreatingInvoice(true);
                }
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
        if(RicPolicy::managementAllowed(true,AmountScreen::hasInput(),lnurlCallbackSent) && WiFi.status()==WL_CONNECTED){
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
