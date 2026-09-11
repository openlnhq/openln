#include "../ui/Theme.h"
#include "BitposClient.h"
#include "../core/ServerTrust.h"
#include "../core/RicPolicy.h"
#include "../core/Version.h"
#include <time.h>

String          BitposClient::_serverUrl;
String          BitposClient::_token;
String          BitposClient::_authHeader;
String          BitposClient::_respBuf;
HTTPClient      BitposClient::_authHttp;
WiFiClientSecure BitposClient::_authClient;
HTTPClient      BitposClient::_pubHttp;
WiFiClientSecure BitposClient::_pubClient;

// Server connections verify the ISRG CA chain and hostname after time sync.
// Bearer tokens authenticate the device; they cannot authenticate a server.
// Third-party card callbacks remain separate from this managed server channel.

// ─── URL scratch buffer ───────────────────────────────────────────────────────
// All URL construction uses snprintf into this buffer — no String temporaries,
// no heap allocations from concatenation.  1024 bytes is required because the
// LNURL callback URL includes the full bolt11 invoice string (~500 chars):
// callbackUrl (~175) + "&k1=" + k1 (64) + "&pr=" + bolt11 (~500) + "&pin=" (4+4) ≈ 750 B
static char _urlBuf[1024];

// ─── POST body scratch buffer ─────────────────────────────────────────────────
// createInvoice request body: {"amountSats":9999999999,"memo":"RIC"} < 64 B
static char _postBody[64];

void BitposClient::init(const String& serverUrl, const String& token) {
    _serverUrl  = serverUrl;
    _token      = token;

    // Pre-allocate auth header once — "Bearer " + token is set at init and
    // never changes, so reserve(64) grabs memory once and subsequent writes
    // (e.g. after re-provisioning) reuse the same buffer.
    _authHeader.reserve(64);
    _authHeader = "Bearer ";
    _authHeader += token;

    // Pre-allocate the shared response buffer.  All HTTP response bodies are
    // read into _respBuf; 1536 bytes covers the largest response we expect
    // (createInvoice returns a bolt11 + hash + metadata ≈ 700 B).
    // Because the buffer is already allocated, repeated _respBuf = getString()
    // calls reuse the same heap block — zero fragmentation from response bodies.
    _respBuf.reserve(1536);

    // Authenticate the server before sending the device credential.
    _authClient.stop();
    _authClient.setCACert(RIC_ROOT_CA);
    _authClient.setHandshakeTimeout(10);
    _authHttp.setConnectTimeout(10000);
    _authHttp.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    _authHttp.setUserAgent(String("openLN-RIC/")+FIRMWARE_VERSION);
    // Keep the TLS session alive across sequential calls to the same server.
    // This eliminates the 1-3 s RSA handshake on every poll/price/invoice call.
    _authHttp.setReuse(true);

    // Pub client — used for third-party LNURL/card-server URLs only.
    // Always setInsecure: card hosts vary per wallet and we can't pin their CAs.
    _pubClient.setInsecure();
}

void BitposClient::releaseConnections() {
    _authHttp.end(); _authClient.stop();
    _pubHttp.end(); _pubClient.stop();
}

bool BitposClient::beginAuthRequest(const char* url) {
    if (!RicPolicy::validBase(_serverUrl.c_str()) || time(nullptr)<1700000000) return false;
    _pubHttp.end(); _pubClient.stop();
    // Release the previous HTTP transaction but keep the TLS socket alive so the
    // next GET/POST reuses the session without a new RSA handshake.
    _authHttp.end();
    _authHttp.setTimeout(10000);
    return _authHttp.begin(_authClient, url);
}

bool BitposClient::beginPubRequest(const char* url) {
    _authHttp.end(); _authClient.stop();
    // Third-party hosts change per transaction — always start clean.
    _pubHttp.end();
    _pubClient.stop();
    _pubHttp.setTimeout(10000);
    return _pubHttp.begin(_pubClient, url);
}

bool BitposClient::healthCheck() {
    snprintf(_urlBuf, sizeof(_urlBuf), "%s/healthz", _serverUrl.c_str());
    if (!beginAuthRequest(_urlBuf)) return false;
    int code = _authHttp.GET();
    _authHttp.end();
    if (code <= 0) _authClient.stop();
    return (code == 200);
}

String BitposClient::fetchCurrency(String& outRateModifier, String& outSendRateModifier) {
    // Response: { "currency": "thb", "sendRateModifier": "THB*0.99" }
    snprintf(_urlBuf, sizeof(_urlBuf), "%s/pos/config", _serverUrl.c_str());
    if (!beginAuthRequest(_urlBuf)) { outRateModifier = ""; outSendRateModifier = ""; return ""; }
    _authHttp.addHeader("Authorization", _authHeader);
    int code = _authHttp.GET();
    if (code != 200) {
        _authHttp.end();
        if (code <= 0) _authClient.stop();
        outRateModifier = "";
        outSendRateModifier = "";
        return "";
    }
    _respBuf = _authHttp.getString();   // reuses pre-allocated buffer
    _authHttp.end();
    DBG_PRINTF("GET %s → HTTP %d\n", _urlBuf, code);

    JsonDocument doc;
    if (deserializeJson(doc, _respBuf)) { outSendRateModifier = ""; return ""; }
    String cur = doc["currency"] | "";
    cur.toLowerCase();
    outRateModifier = doc["rateModifier"] | "";
    outSendRateModifier = doc["sendRateModifier"] | "";
    return cur;
}

float BitposClient::fetchPrice(const String& currency) {
    // Response: { "currency": "usd", "price": 95000.0 }
    // price = BTC price in fiat; returns sats-per-fiat = 100_000_000 / price
    snprintf(_urlBuf, sizeof(_urlBuf), "%s/price?vs_currency=%s",
             _serverUrl.c_str(), currency.c_str());
    if (!beginAuthRequest(_urlBuf)) return 0.0f;
    _authHttp.addHeader("Authorization", _authHeader);
    int code = _authHttp.GET();
    if (code != 200) {
        _authHttp.end();
        if (code <= 0) _authClient.stop();
        return 0.0f;
    }
    _respBuf = _authHttp.getString();   // reuses pre-allocated buffer
    _authHttp.end();
    DBG_PRINTF("GET %s → HTTP %d\n", _urlBuf, code);

    JsonDocument doc;
    if (deserializeJson(doc, _respBuf)) return 0.0f;
    float btcPrice = doc["price"] | 0.0f;
    if (btcPrice <= 0.0f) return 0.0f;
    return 100000000.0f / btcPrice;     // sats per 1 unit of currency
}

String BitposClient::pollInvoiceStatus(const String& paymentHash) {
    snprintf(_urlBuf, sizeof(_urlBuf), "%s/pos/invoice/%s/status",
             _serverUrl.c_str(), paymentHash.c_str());
    if (!beginAuthRequest(_urlBuf)) {
        _authClient.stop();
        return "error";
    }
    _authHttp.addHeader("Authorization", _authHeader);
    int code = _authHttp.GET();
    DBG_PRINTF("GET %s → HTTP %d\n", _urlBuf, code);
    if (code != 200) {
        _authHttp.end();
        if (code <= 0) _authClient.stop();
        return "error";
    }
    _respBuf = _authHttp.getString();   // reuses pre-allocated buffer
    _authHttp.end();

    JsonDocument doc;
    if (deserializeJson(doc, _respBuf)) return "error";
    return doc["status"] | "pending";
}

Invoice BitposClient::createInvoice(long amountSats, String& err) {
    Invoice inv;
    snprintf(_urlBuf, sizeof(_urlBuf), "%s/pos/invoice", _serverUrl.c_str());
    // Build request JSON in static buffer — no heap allocation
    snprintf(_postBody, sizeof(_postBody),
             "{\"amountSats\":%ld,\"memo\":\"RIC\"}", amountSats);

    if (!beginAuthRequest(_urlBuf)) {
        _authClient.stop();
        err = "Connection failed";
        return inv;
    }
    _authHttp.addHeader("Authorization", _authHeader);
    _authHttp.addHeader("Content-Type", "application/json");
    int code = _authHttp.POST((uint8_t*)_postBody, strlen(_postBody));
    DBG_PRINTF("POST %s → HTTP %d\n", _urlBuf, code);
    if (code <= 0) {
        _authHttp.end();
        _authClient.stop();
        err = "Transport error";
        return inv;
    }
    _respBuf = _authHttp.getString();   // reuses pre-allocated buffer
    _authHttp.end();

    JsonDocument doc;
    if (deserializeJson(doc, _respBuf)) { err = "Invalid JSON"; return inv; }

    if (doc["error"].is<const char*>()) {
        err = doc["error"].as<String>();
        return inv;
    }

    // These assignments write into pre-allocated Invoice fields (reserved in
    // main.cpp's handleConnectingWifi after WiFi connects).  As long as the
    // content fits within the reserved capacity no heap reallocation occurs.
    inv.bolt11      = doc["bolt11"].as<String>();
    inv.paymentHash = doc["paymentHash"].as<String>();
    inv.amountSats  = doc["amountSats"].as<long>();
    inv.expiresAt   = doc["expiresAt"].as<String>();
    return inv;
}

BitposClient::LnurlWithdraw BitposClient::fetchLnurl(const String& url, String& err) {
    LnurlWithdraw lw;
    // doPublicGet replacement — third-party card server; must NOT send device Bearer token
    if (!beginPubRequest(url.c_str())) {
        err = "No response from card server";
        return lw;
    }
    int code = _pubHttp.GET();
    if (code != 200) {
        _pubHttp.end();
        _pubClient.stop();
        err = "No response from card server";
        return lw;
    }
    _respBuf = _pubHttp.getString();    // reuses pre-allocated buffer
    _pubHttp.end();
    _pubClient.stop();

    JsonDocument doc;
    if (deserializeJson(doc, _respBuf)) { err = "Invalid JSON from card"; return lw; }

    if (doc["status"] == "ERROR") {
        err = doc["reason"] | "Card declined";
        return lw;
    }

    lw.tag                = doc["tag"] | "";
    lw.callback           = doc["callback"] | "";
    lw.k1                 = doc["k1"] | "";
    lw.maxWithdrawable    = doc["maxWithdrawable"] | 0L;
    lw.defaultDescription = doc["defaultDescription"] | "";
    // LUD-21: pinLimit is in msats; absent field means no PIN required.
    lw.pinLimitMsats = doc["pinLimit"].isNull() ? -1L : doc["pinLimit"].as<long>();

    if (lw.tag != "withdrawRequest" || lw.callback.isEmpty()) {
        err = "Invalid LNURL-withdraw response";
    }
    return lw;
}

String BitposClient::callLnurlCallback(const String& callbackUrl,
                                       const String& k1,
                                       const String& bolt11,
                                       const String& pin) {
    // Build URL from components — avoids fragile string-slice reconstruction.
    // Use _urlBuf for the base; append directly since callback URL may already
    // contain '?' — total length should stay well under 256 bytes.
    snprintf(_urlBuf, sizeof(_urlBuf), "%s%sk1=%s&pr=%s%s%s",
             callbackUrl.c_str(),
             (callbackUrl.indexOf('?') < 0 ? "?" : "&"),
             k1.c_str(),
             bolt11.c_str(),
             (pin.isEmpty() ? "" : "&pin="),
             (pin.isEmpty() ? "" : pin.c_str()));

    // Uses ephemeral pub client — third-party card server; must NOT send device token
    if (!beginPubRequest(_urlBuf)) return "Connection failed";
    int code = _pubHttp.GET();
    _respBuf = _pubHttp.getString();    // reuses pre-allocated buffer
    _pubHttp.end();
    _pubClient.stop();

    if (code != 200) return "Server returned " + String(code);

    JsonDocument doc;
    if (deserializeJson(doc, _respBuf)) return "Invalid response";

    String status = doc["status"] | "ERROR";
    if (status == "OK") return "";
    return doc["reason"] | "Payment failed";
}

// ── Send mode: create a LNURL-W for outward payment ─────────────────────────
String BitposClient::createWithdraw(long amountSats, const String& pin, String& err, String& outK1) {
    snprintf(_urlBuf, sizeof(_urlBuf), "%s/pos/withdraw", _serverUrl.c_str());
    char body[96];
    snprintf(body, sizeof(body),
             "{\"amountSats\":%ld,\"pin\":\"%s\"}", amountSats, pin.c_str());

    if (!beginAuthRequest(_urlBuf)) {
        _authClient.stop();
        err = "Connection failed";
        return "";
    }
    _authHttp.addHeader("Authorization", _authHeader);
    _authHttp.addHeader("Content-Type", "application/json");
    int code = _authHttp.POST((uint8_t*)body, strlen(body));
    DBG_PRINTF("POST %s → HTTP %d\n", _urlBuf, code);
    if (code <= 0) {
        _authHttp.end();
        _authClient.stop();
        err = "Transport error";
        return "";
    }
    _respBuf = _authHttp.getString();
    _authHttp.end();

    JsonDocument doc;
    if (deserializeJson(doc, _respBuf)) { err = "Invalid JSON"; return ""; }
    if (doc["error"].is<const char*>()) {
        err = doc["error"].as<String>();
        return "";
    }
    outK1 = doc["k1"] | "";
    return doc["lnurlw"] | "";
}

// ── Send mode: poll withdrawal status ─────────────────────────────────────
String BitposClient::pollWithdrawStatus(const String& k1) {
    snprintf(_urlBuf, sizeof(_urlBuf), "%s/pos/withdraw/%s/status",
             _serverUrl.c_str(), k1.c_str());
    if (!beginAuthRequest(_urlBuf)) {
        _authClient.stop();
        return "error";
    }
    _authHttp.addHeader("Authorization", _authHeader);
    int code = _authHttp.GET();
    DBG_PRINTF("GET %s → HTTP %d\n", _urlBuf, code);
    if (code != 200) {
        _authHttp.end();
        if (code <= 0) _authClient.stop();
        return "error";
    }
    _respBuf = _authHttp.getString();
    _authHttp.end();

    JsonDocument doc;
    if (deserializeJson(doc, _respBuf)) return "error";
    return doc["status"] | "pending";
}

// ── Send mode: pay a bitPOS card holder directly ───────────────────────────
String BitposClient::sendToCard(const String& cardUrl, long amountSats,
                                const String& pin, String& err) {
    snprintf(_urlBuf, sizeof(_urlBuf), "%s/pos/send-to-card", _serverUrl.c_str());
    // Body: {"cardUrl":"...","amountSats":N,"pin":"xxxx"}
    // cardUrl includes the full URL with p + c params from the NFC read.
    // Use _respBuf as a scratch for the body since cardUrl can be ~200 chars.
    String body = String("{\"cardUrl\":\"") + cardUrl +
                  "\",\"amountSats\":" + String(amountSats) +
                  ",\"pin\":\"" + pin + "\"}";

    if (!beginAuthRequest(_urlBuf)) {
        _authClient.stop();
        err = "Connection failed";
        return "";
    }
    _authHttp.addHeader("Authorization", _authHeader);
    _authHttp.addHeader("Content-Type", "application/json");
    int code = _authHttp.POST((uint8_t*)body.c_str(), body.length());
    DBG_PRINTF("POST %s → HTTP %d\n", _urlBuf, code);
    if (code <= 0) {
        _authHttp.end();
        _authClient.stop();
        err = "Transport error";
        return "";
    }
    _respBuf = _authHttp.getString();
    _authHttp.end();

    JsonDocument doc;
    if (deserializeJson(doc, _respBuf)) { err = "Invalid JSON"; return ""; }
    if (doc["error"].is<const char*>()) {
        err = doc["error"].as<String>();
        return "";
    }
    String status = doc["status"] | "ERROR";
    if (status == "OK") return "";
    err = doc["reason"] | "Send failed";
    return err;
}

// ── Card provisioning ───────────────────────────────────────────────────────

bool BitposClient::fetchNextProvision(ProvisionData& data, String& err) {
    snprintf(_urlBuf, sizeof(_urlBuf), "%s/pos/next-provision", _serverUrl.c_str());
    if (!beginAuthRequest(_urlBuf)) {
        _authClient.stop();
        err = "Connection failed";
        return false;
    }
    _authHttp.addHeader("Authorization", _authHeader);
    int code = _authHttp.GET();
    DBG_PRINTF("GET %s -> HTTP %d\n", _urlBuf, code);
    if (code != 200) {
        _respBuf = _authHttp.getString();
        _authHttp.end();
        if (code <= 0) _authClient.stop();
        JsonDocument doc;
        if (!deserializeJson(doc, _respBuf)) {
            err = doc["error"] | "No pending cards";
        } else {
            err = "No pending cards";
        }
        return false;
    }
    _respBuf = _authHttp.getString();
    _authHttp.end();

    JsonDocument doc;
    if (deserializeJson(doc, _respBuf)) { err = "Invalid JSON"; return false; }

    data.cardId        = doc["cardId"] | "";
    data.ndefFileHex   = doc["ndefFile"] | "";
    data.sdmSettingsHex = doc["sdmSettings"] | "";
    data.k0            = doc["k0"] | "";
    data.k1            = doc["k1"] | "";
    data.k2            = doc["k2"] | "";
    data.k3            = doc["k3"] | "";
    data.k4            = doc["k4"] | "";

    if (data.cardId.isEmpty() || data.ndefFileHex.isEmpty()) {
        err = "Incomplete provision data";
        return false;
    }
    return true;
}

bool BitposClient::markCardWritten(const String& cardId, String& err) {
    snprintf(_urlBuf, sizeof(_urlBuf), "%s/pos/mark-written/%s",
             _serverUrl.c_str(), cardId.c_str());
    if (!beginAuthRequest(_urlBuf)) {
        _authClient.stop();
        err = "Connection failed";
        return false;
    }
    _authHttp.addHeader("Authorization", _authHeader);
    int code = _authHttp.POST((uint8_t*)"", 0);
    _authHttp.end();
    if (code <= 0) _authClient.stop();
    DBG_PRINTF("POST %s -> HTTP %d\n", _urlBuf, code);
    return (code == 200);
}

bool BitposClient::fetchWipeKeys(const String& cardId, WipeData& data, String& err) {
    snprintf(_urlBuf, sizeof(_urlBuf), "%s/pos/wipe-keys/%s",
             _serverUrl.c_str(), cardId.c_str());
    if (!beginAuthRequest(_urlBuf)) {
        _authClient.stop();
        err = "Connection failed";
        return false;
    }
    _authHttp.addHeader("Authorization", _authHeader);
    int code = _authHttp.GET();
    DBG_PRINTF("GET %s -> HTTP %d\n", _urlBuf, code);
    if (code != 200) {
        _respBuf = _authHttp.getString();
        _authHttp.end();
        if (code <= 0) _authClient.stop();
        err = "Card not found or access denied";
        return false;
    }
    _respBuf = _authHttp.getString();
    _authHttp.end();

    JsonDocument doc;
    if (deserializeJson(doc, _respBuf)) { err = "Invalid JSON"; return false; }

    data.cardId             = doc["cardId"] | "";
    data.k0                 = doc["k0"] | "";
    data.k1                 = doc["k1"] | "";
    data.k2                 = doc["k2"] | "";
    data.k3                 = doc["k3"] | "";
    data.k4                 = doc["k4"] | "";
    data.factorySettingsHex = doc["factorySettings"] | "";

    return true;
}

bool BitposClient::markCardWiped(const String& cardId, String& err) {
    snprintf(_urlBuf, sizeof(_urlBuf), "%s/pos/mark-wiped/%s",
             _serverUrl.c_str(), cardId.c_str());
    if (!beginAuthRequest(_urlBuf)) {
        _authClient.stop();
        err = "Connection failed";
        return false;
    }
    _authHttp.addHeader("Authorization", _authHeader);
    int code = _authHttp.POST((uint8_t*)"", 0);
    _authHttp.end();
    if (code <= 0) _authClient.stop();
    DBG_PRINTF("POST %s -> HTTP %d\n", _urlBuf, code);
    return (code == 200);
}
