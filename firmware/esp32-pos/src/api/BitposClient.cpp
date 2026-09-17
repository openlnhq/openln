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
bool BitposClient::_publicUsesAuth = false;

// Server connections verify the ISRG CA chain and hostname after time sync.
// Bearer tokens authenticate the device; they cannot authenticate a server.
// Third-party card callbacks remain separate from this managed server channel.

// ─── URL scratch buffer ───────────────────────────────────────────────────────
// All URL construction uses snprintf into this buffer — no String temporaries,
// no heap allocations from concatenation.  1024 bytes is required because the
// LNURL callback URL includes the full bolt11 invoice string (~500 chars):
// callbackUrl (~175) + "&k1=" + k1 (64) + "&pr=" + bolt11 (~500) + "&pin=" (4+4) ≈ 750 B
static char _urlBuf[CardTransportPolicy::MaxUrlChars + 1];

// ─── POST body scratch buffer ─────────────────────────────────────────────────
// createInvoice request body: {"amountSats":9999999999,"memo":"RIC"} < 64 B
static char _postBody[CardTransportPolicy::MaxBodyBytes + 1];

namespace {
using Outcome = CardTransportPolicy::Outcome;
bool boundedText(const String& s, size_t maximum, bool empty = false) {
    return (empty || !s.isEmpty()) && s.length() <= maximum && strlen(s.c_str()) == s.length();
}
bool digits(const String& s, size_t minimum, size_t maximum) {
    if (s.length() < minimum || s.length() > maximum) return false;
    for (size_t i = 0; i < s.length(); ++i) if (s[i] < '0' || s[i] > '9') return false;
    return true;
}
bool managedKey(const String& key) {
    if (key.length() != 64) return false;
    for (size_t i = 0; i < key.length(); ++i)
        if (!((key[i] >= '0' && key[i] <= '9') || (key[i] >= 'a' && key[i] <= 'f'))) return false;
    return true;
}
bool jsonKey(JsonVariantConst value) {
    return value.is<JsonString>() && managedKey(value.as<String>());
}
bool validAmount(long amount) { return amount > 0 && int64_t(amount) <= INT32_MAX; }
bool encodeBody(const JsonDocument& doc, size_t& size) {
    size = measureJson(doc);
    if (doc.overflowed() || size > CardTransportPolicy::MaxBodyBytes) return false;
    return serializeJson(doc, _postBody, sizeof(_postBody)) == size;
}
void eraseBody() {
    volatile char* p = _postBody;
    for (size_t i = 0; i < sizeof(_postBody); ++i) p[i] = 0;
}
bool bolt11Text(const String& invoice) {
    if (!boundedText(invoice, CardTransportPolicy::MaxUrlChars) || invoice.length() < 20) return false;
    char prefix[5];
    for (size_t i = 0; i < 4; ++i) prefix[i] = CardTransportPolicy::lower(invoice[i]);
    prefix[4] = 0;
    if (strcmp(prefix, "lnbc") && strcmp(prefix, "lntb")) return false;
    for (size_t i = 0; i < invoice.length(); ++i) {
        const char c = CardTransportPolicy::lower(invoice[i]);
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return false;
    }
    return true;
}
bool jsonEquals(JsonVariantConst value, const String& expected) {
    if (!value.is<JsonString>()) return false;
    const JsonString s = value.as<JsonString>();
    return s.size() == expected.length() && !memcmp(s.c_str(), expected.c_str(), s.size());
}
bool jsonText(JsonVariantConst value, size_t maximum, bool empty = false) {
    if (!value.is<JsonString>()) return false;
    const JsonString s = value.as<JsonString>();
    return (empty || s.size() != 0) && s.size() <= maximum && strlen(s.c_str()) == s.size();
}
bool jsonObject(const String& body, JsonDocument& doc) {
    // ArduinoJson accepts a valid prefix. Do not accept a terminal/PIN proof
    // followed by truncated, concatenated or otherwise malformed JSON.
    size_t depth = 0, end = 0;
    bool quoted = false, escaped = false, begun = false;
    for (size_t i = 0; i < body.length(); ++i) {
        const char c = body[i];
        if (!begun) {
            if (c == ' ' || c == '\r' || c == '\n' || c == '\t') continue;
            if (c != '{') return false;
            begun = true;
        }
        if (quoted) {
            if (escaped) escaped = false;
            else if (c == '\\') escaped = true;
            else if (c == '"') quoted = false;
        } else if (c == '"') quoted = true;
        else if (c == '{' || c == '[') { if (++depth > 6) return false; }
        else if (c == '}' || c == ']') {
            if (!depth) return false;
            if (--depth == 0) { end = i + 1; break; }
        }
    }
    if (!end || quoted) return false;
    for (size_t i = end; i < body.length(); ++i)
        if (body[i] != ' ' && body[i] != '\r' && body[i] != '\n' && body[i] != '\t') return false;
    return !deserializeJson(doc, body, DeserializationOption::NestingLimit(6)) && doc.is<JsonObject>();
}
bool nonDispatchProof(const JsonDocument& doc) {
    return doc["dispatched"].is<bool>() && !doc["dispatched"].as<bool>() &&
           (doc["doNotRetry"].isUnbound() || (doc["doNotRetry"].is<bool>() && !doc["doNotRetry"].as<bool>()));
}
class UrlBuilder {
    char* data;
    size_t cap, used = 0;
public:
    UrlBuilder(char* buffer, size_t capacity):data(buffer),cap(capacity) { data[0] = 0; }
    bool add(const char* s) {
        const size_t n = strlen(s);
        if (n >= cap - used) return false;
        memcpy(data + used, s, n + 1); used += n; return true;
    }
    bool encoded(const String& value) {
        static const char hex[] = "0123456789ABCDEF";
        for (size_t i = 0; i < value.length(); ++i) {
            const unsigned char c = static_cast<unsigned char>(value[i]);
            char out[4] = {0, 0, 0, 0};
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~') out[0] = char(c);
            else { out[0] = '%'; out[1] = hex[c >> 4]; out[2] = hex[c & 15]; }
            if (!add(out)) return false;
        }
        return true;
    }
};
bool callbackHasReservedQuery(const String& url) {
    int query = url.indexOf('?');
    if (query < 0) return false;
    size_t start = size_t(query) + 1;
    while (start < url.length()) {
        char key[4] = {0,0,0,0}; size_t used = 0, i = start;
        while (i < url.length() && url[i] != '=' && url[i] != '&') {
            char c = url[i++];
            if (c == '%' && i + 1 < url.length()) {
                const char a = CardTransportPolicy::lower(url[i++]);
                const char b = CardTransportPolicy::lower(url[i++]);
                c = char((a <= '9' ? a-'0' : a-'a'+10) * 16 + (b <= '9' ? b-'0' : b-'a'+10));
            }
            if (used < 3) key[used] = c;
            ++used;
        }
        if ((used == 2 && (!strcmp(key, "k1") || !strcmp(key, "pr"))) || (used == 3 && !strcmp(key, "pin"))) return true;
        while (i < url.length() && url[i] != '&') ++i;
        start = i + 1;
    }
    return false;
}
// HTTPClient::getString() allocates an unbounded temporary; writeToStream()
// also has an unbounded chunk-header String and only an idle timeout. Consume
// its existing raw Stream with a fixed framing buffer and one absolute budget.
class CappedBodyReader {
    Stream& stream;
    WiFiClientSecure& client;
    String& out;
    uint32_t started = millis();
    size_t framingBytes = 0;
    int next() {
        while (uint32_t(millis() - started) < CardTransportPolicy::BodyTimeoutMs) {
            if (stream.available() > 0) {
                int c = stream.read();
                if (c >= 0) return c;
            }
            if (!client.connected()) return -1;
            delay(1);
        }
        return -1;
    }
    bool append(int c) {
        if (c <= 0 || out.length() >= CardTransportPolicy::MaxBodyBytes) return false;
        const char b = char(c);
        return out.concat(&b, 1);
    }
    bool line(char* text, size_t cap) {
        size_t n = 0;
        for (;;) {
            int c = next();
            if (c < 0 || ++framingBytes > CardTransportPolicy::MaxBodyBytes * 8) return false;
            if (c == '\r') {
                if (next() != '\n') return false;
                ++framingBytes;
                text[n] = 0;
                return true;
            }
            if (c < 32 || c > 126 || n + 1 >= cap) return false;
            text[n++] = char(c);
        }
    }
public:
    CappedBodyReader(Stream& s, WiFiClientSecure& c, String& output):stream(s),client(c),out(output) {}
    bool fixed(size_t n) {
        if (n > CardTransportPolicy::MaxBodyBytes - out.length()) return false;
        while (n--) if (!append(next())) return false;
        return true;
    }
    bool untilClose() {
        for (;;) {
            const int c = next();
            if (c < 0) return !client.connected() && uint32_t(millis()-started) < CardTransportPolicy::BodyTimeoutMs;
            if (!append(c)) return false;
        }
    }
    bool chunked() {
        char text[128];
        for (;;) {
            if (!line(text, sizeof(text))) return false;
            size_t n = 0, i = 0;
            for (; CardTransportPolicy::hexDigit(text[i]); ++i) {
                const char c = CardTransportPolicy::lower(text[i]);
                const unsigned digit = c <= '9' ? unsigned(c-'0') : unsigned(c-'a'+10);
                n = n * 16 + digit;
                if (n > CardTransportPolicy::MaxBodyBytes) return false;
            }
            if (!i || (text[i] && text[i] != ';')) return false;
            if (!n) {
                size_t trailers = 0;
                do {
                    if (!line(text, sizeof(text))) return false;
                    trailers += strlen(text) + 2;
                    if (trailers > 512 || (text[0] && !strchr(text, ':'))) return false;
                } while (text[0]);
                return true;
            }
            if (!fixed(n) || next() != '\r' || next() != '\n') return false;
        }
    }
};
}

bool BitposClient::readResponse(HTTPClient& http, WiFiClientSecure& client, int code) {
    _respBuf = "";
    bool ok = false;
    String encoding = http.header("Transfer-Encoding");
    encoding.toLowerCase();
    encoding.trim();
    const String length = http.header("Content-Length");
    const String compression = http.header("Content-Encoding");
    Stream* stream = http.getStreamPtr();
    if (code > 0 && stream && _respBuf.reserve(CardTransportPolicy::MaxBodyBytes) &&
        (compression.isEmpty() || compression == "identity")) {
        CappedBodyReader reader(*stream, client, _respBuf);
        if (encoding == "chunked") {
            if (length.isEmpty() && http.getSize() < 0) ok = reader.chunked();
        } else if (encoding.isEmpty() || encoding == "identity") {
            if (!length.isEmpty()) {
                size_t n = 0;
                bool valid = length.length() <= 10;
                for (size_t i = 0; valid && i < length.length(); ++i) {
                    const char c = length[i];
                    if (c < '0' || c > '9') { valid = false; break; }
                    n = n * 10 + unsigned(c-'0');
                    if (n > CardTransportPolicy::MaxBodyBytes) valid = false;
                }
                if (valid && http.getSize() >= 0 && n == size_t(http.getSize())) ok = reader.fixed(n);
            } else if (http.getSize() < 0) {
                ok = reader.untilClose();
            }
        }
    }
    if (!ok) { _respBuf = ""; client.stop(); }
    http.end(); // clears every custom request header, retains only a fully drained TLS connection
    http.setAuthorization("");
    return ok;
}

void BitposClient::init(const String& serverUrl, const String& token) {
    releaseConnections();
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
    _respBuf.reserve(CardTransportPolicy::MaxBodyBytes);
    const char* headers[] = {"Transfer-Encoding", "Content-Length", "Content-Encoding"};
    _authHttp.collectHeaders(headers, 3);
    _pubHttp.collectHeaders(headers, 3);

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

    // Public requests authenticate CA + hostname too. Unsupported roots fail
    // closed; never turn a TLS/PIN error into an insecure retry.
    _pubClient.setCACert(RIC_ROOT_CA);
    _pubClient.setHandshakeTimeout(CardTransportPolicy::HandshakeTimeoutSec);
    _pubHttp.setConnectTimeout(CardTransportPolicy::ConnectTimeoutMs);
    _pubHttp.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    _pubHttp.setUserAgent(String("openLN-RIC/") + FIRMWARE_VERSION);
    _pubHttp.setReuse(false);
}

void BitposClient::releaseConnections() {
    _authHttp.end(); _authClient.stop();
    _pubHttp.end(); _pubClient.stop();
}

bool BitposClient::beginAuthRequest(const char* url) {
    if (!RicPolicy::validBase(_serverUrl.c_str()) || time(nullptr)<1700000000 ||
        !CardTransportPolicy::sameOrigin(_serverUrl.c_str(), url)) return false;
    _pubHttp.end(); _pubClient.stop();
    // Release the previous HTTP transaction but keep the TLS socket alive so the
    // next GET/POST reuses the session without a new RSA handshake.
    _authHttp.end();
    _authHttp.setAuthorization(""); // end() clears custom headers, not Basic auth
    _authHttp.setTimeout(CardTransportPolicy::BodyTimeoutMs);
#ifdef ARDUINO_ARCH_ESP32
    if (!_authClient.connected()) {
        CardTransportPolicy::Origin origin;
        if (CardTransportPolicy::httpsUrl(url, &origin)) {
            String host(origin.host, origin.hostLength);
            IPAddress address;
            const bool resolved=WiFi.hostByName(host.c_str(),address);
            Serial.printf("RIC TLS retry: fd=%d wifi=%d rssi=%d ip=%s target=%s:%u dns=%s\n",
                _authClient.fd(),int(WiFi.status()),WiFi.RSSI(),WiFi.localIP().toString().c_str(),
                host.c_str(),origin.port,resolved?address.toString().c_str():"failed");
        }
    }
#endif
    return _authHttp.begin(_authClient, url);
}

bool BitposClient::beginPubRequest(const char* url) {
    if (time(nullptr)<1700000000 || !CardTransportPolicy::httpsUrl(url)) return false;
    _publicUsesAuth = CardTransportPolicy::sameOrigin(_serverUrl.c_str(), url);
    if (_publicUsesAuth) return beginAuthRequest(url);
    _authHttp.end(); _authClient.stop();
    // Third-party hosts change per transaction — always start clean.
    _pubHttp.end();
    _pubClient.stop();
    _pubHttp.setAuthorization("");
    _pubHttp.setTimeout(CardTransportPolicy::BodyTimeoutMs);
    return _pubHttp.begin(_pubClient, url);
}

bool BitposClient::healthCheck() {
    snprintf(_urlBuf, sizeof(_urlBuf), "%s/healthz", _serverUrl.c_str());
    if (!beginAuthRequest(_urlBuf)) return false;
    int code = _authHttp.GET();
    return readResponse(_authHttp, _authClient, code) && code == 200;
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
    readResponse(_authHttp, _authClient, code);
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
    readResponse(_authHttp, _authClient, code);
    _authHttp.end();
    DBG_PRINTF("GET %s → HTTP %d\n", _urlBuf, code);

    JsonDocument doc;
    if (deserializeJson(doc, _respBuf)) return 0.0f;
    float btcPrice = doc["price"] | 0.0f;
    if (btcPrice <= 0.0f) return 0.0f;
    return 100000000.0f / btcPrice;     // sats per 1 unit of currency
}

String BitposClient::pollInvoiceStatus(const String& paymentHash) {
    if(!managedKey(paymentHash))return "error";
    snprintf(_urlBuf,sizeof(_urlBuf),"%s/pos/invoice/%s/status",_serverUrl.c_str(),paymentHash.c_str());
    if(!beginAuthRequest(_urlBuf))return "error";
    _authHttp.addHeader("Authorization",_authHeader);
    const int code=_authHttp.GET();
    if(!readResponse(_authHttp,_authClient,code) || code!=200)return "error";
    JsonDocument doc;
    if(!jsonObject(_respBuf,doc) || !jsonEquals(doc["paymentHash"],paymentHash) || !jsonText(doc["status"],32))return "error";
    const String status=doc["status"].as<String>();
    if(status=="paid" || status=="pending" || status=="created" || status=="accepted" || status=="forwarding" || status=="forwarded" || status=="needs_reconciliation")return status;
    // Card failure does not close the exposed invoice: main requests cancellation.
    if(status=="card_failed" && jsonEquals(doc["code"],"INSUFFICIENT_BALANCE") &&
       doc["paymentFailed"].is<bool>() && doc["paymentFailed"].as<bool>() &&
       doc["dispatched"].is<bool>() && doc["dispatched"].as<bool>())return status;
    if((status=="cancelled" || status=="expired") && nonDispatchProof(doc))return status;
    return "error";
}

Invoice BitposClient::createInvoice(long amountSats,String& err) {
    Invoice inv;err="";
    if(!validAmount(amountSats)){err="Invalid amount";return inv;}
    snprintf(_urlBuf,sizeof(_urlBuf),"%s/pos/invoice",_serverUrl.c_str());
    snprintf(_postBody,sizeof(_postBody),"{\"amountSats\":%ld,\"memo\":\"RIC\"}",amountSats);
    if(!beginAuthRequest(_urlBuf)){err="Secure connection unavailable";return inv;}
    _authHttp.addHeader("Authorization",_authHeader);_authHttp.addHeader("Content-Type","application/json");
    const int code=_authHttp.POST(reinterpret_cast<uint8_t*>(_postBody),strlen(_postBody));
    JsonDocument doc;
    if(!readResponse(_authHttp,_authClient,code) || code!=201 || !jsonObject(_respBuf,doc) ||
       !jsonText(doc["bolt11"],1249) || !jsonKey(doc["paymentHash"]) || !doc["amountSats"].is<long>() ||
       doc["amountSats"].as<long>()!=amountSats || !bolt11Text(doc["bolt11"].as<String>())) {
        err="Invalid or incomplete invoice response";return inv;
    }
    inv.bolt11=doc["bolt11"].as<String>();inv.paymentHash=doc["paymentHash"].as<String>();inv.amountSats=amountSats;
    inv.expiresAt=doc["expiresAt"] | "";
    struct tm expiry{};
    int year,month,day,hour,minute,second;
    if(sscanf(inv.expiresAt.c_str(),"%d-%d-%dT%d:%d:%d",&year,&month,&day,&hour,&minute,&second)==6 &&
       year>=2020 && year<=2099 && month>=1 && month<=12 && day>=1 && day<=31 && hour>=0 && hour<=23 && minute>=0 && minute<=59 && second>=0 && second<=59) {
        expiry.tm_year=year-1900;expiry.tm_mon=month-1;expiry.tm_mday=day;expiry.tm_hour=hour;expiry.tm_min=minute;expiry.tm_sec=second;
        const time_t end=mktime(&expiry),now=time(nullptr);
        if(end>now)inv.ttlSec=static_cast<uint32_t>(std::min<int64_t>(600,static_cast<int64_t>(end)-now));
        else {inv=Invoice{};err="Invoice already expired";}
    }
    return inv;
}

BitposClient::LnurlWithdraw BitposClient::fetchLnurl(const String& url, String& err) {
    LnurlWithdraw lw;
    err = "";
    if (!CardTransportPolicy::httpsUrl(url.c_str(), url.length())) {
        err = "Invalid secure card URL";
        return lw;
    }
    // doPublicGet replacement — third-party card server; must NOT send device Bearer token
    if (!beginPubRequest(url.c_str())) {
        err = "No response from card server";
        return lw;
    }
    HTTPClient& http = _publicUsesAuth ? _authHttp : _pubHttp;
    WiFiClientSecure& client = _publicUsesAuth ? _authClient : _pubClient;
    int code = http.GET();
    if (code != 200) {
        http.end();
        client.stop();
        err = "No response from card server";
        return lw;
    }
    readResponse(http, client, code);
    http.end();
    if (!_publicUsesAuth) client.stop();

    JsonDocument doc;
    if (deserializeJson(doc, _respBuf)) { err = "Invalid JSON from card"; return lw; }

    if (doc["status"] == "ERROR") {
        err = doc["reason"] | "Card declined";
        return lw;
    }

    if (!jsonObject(_respBuf,doc) || !jsonEquals(doc["tag"],"withdrawRequest") ||
        !jsonText(doc["callback"],CardTransportPolicy::MaxUrlChars) || !jsonText(doc["k1"],256) ||
        !doc["maxWithdrawable"].is<int64_t>() || doc["maxWithdrawable"].as<int64_t>()<0 ||
        (!doc["pinLimit"].isNull() && (!doc["pinLimit"].is<int64_t>() || doc["pinLimit"].as<int64_t>()<0))) {
        err="Invalid card response"; return lw;
    }
    const String callback=doc["callback"].as<String>();
    if (!CardTransportPolicy::httpsUrl(callback.c_str(),callback.length())) {
        err="Invalid secure callback URL"; return lw;
    }
    lw.tag="withdrawRequest"; lw.callback=callback; lw.k1=doc["k1"].as<String>();
    lw.maxWithdrawable=doc["maxWithdrawable"].as<int64_t>();
    lw.pinLimitMsats=doc["pinLimit"].isNull()?-1:doc["pinLimit"].as<int64_t>();
    lw.defaultDescription=doc["defaultDescription"] | "";
    return lw;
}

CardTransportPolicy::Outcome BitposClient::submitLnurlCallback(
    const String& callbackUrl, const String& k1, const String& bolt11,
    const String& pin, String& detail) {
    detail = "Invalid card payment request";
    if (!CardTransportPolicy::httpsUrl(callbackUrl.c_str(), callbackUrl.length()) ||
        callbackHasReservedQuery(callbackUrl) || !boundedText(k1, 256) ||
        !bolt11Text(bolt11) || (!pin.isEmpty() && !digits(pin, 4, 4))) return Outcome::NotSubmitted;
    UrlBuilder url(_urlBuf, sizeof(_urlBuf));
    if (!url.add(callbackUrl.c_str()) || !url.add(callbackUrl.indexOf('?') < 0 ? "?k1=" : "&k1=") ||
        !url.encoded(k1) || !url.add("&pr=") || !url.encoded(bolt11) ||
        (!pin.isEmpty() && (!url.add("&pin=") || !url.encoded(pin)))) {
        detail = "Card payment URL is too long";
        return Outcome::NotSubmitted;
    }
    if (!beginPubRequest(_urlBuf)) { detail = "Secure connection unavailable"; return Outcome::NotSubmitted; }
    HTTPClient& http = _publicUsesAuth ? _authHttp : _pubHttp;
    WiFiClientSecure& client = _publicUsesAuth ? _authClient : _pubClient;
    // From this point even a send-header or TLS error is conservatively unknown.
    // Never reconnect-and-repeat a request that may have reached the wallet.
    const int code = http.GET();
    detail = "Payment confirmation pending. Do not submit again.";
    if (!readResponse(http, client, code) || code != 200) return Outcome::Pending;
    JsonDocument doc;
    if (!jsonObject(_respBuf, doc)) return Outcome::Pending;
    if (!doc["k1"].isUnbound() && !jsonEquals(doc["k1"], k1)) return Outcome::Pending;
    if (jsonEquals(doc["status"], "OK")) {
        detail = "Payment accepted. Awaiting settlement.";
        return Outcome::Pending;
    }
    // A dispatched pay_invoice can be definitively declined. Only trust the
    // same-origin, challenge-bound contract; generic LNURL errors stay pending.
    if(CardTransportPolicy::sameOrigin(_serverUrl.c_str(),callbackUrl.c_str()) &&
       jsonEquals(doc["status"],"ERROR") && jsonEquals(doc["k1"],k1) &&
       jsonEquals(doc["code"],"INSUFFICIENT_BALANCE") &&
       doc["paymentFailed"].is<bool>() && doc["paymentFailed"].as<bool>() &&
       doc["dispatched"].is<bool>() && doc["dispatched"].as<bool>()) {
        detail="Insufficient balance"; return Outcome::Failed;
    }
    // These are openLN's explicit rearmed-challenge codes, not generic LNURL
    // prose. Legacy bitpos.app stays CA/hostname checked, without redirection.
    const bool pinContract = CardTransportPolicy::sameOrigin(_serverUrl.c_str(), callbackUrl.c_str()) ||
                             CardTransportPolicy::sameOrigin("https://bitpos.app/", callbackUrl.c_str());
    if (pinContract && jsonEquals(doc["status"], "ERROR") && nonDispatchProof(doc)) {
        if (jsonEquals(doc["code"], "PIN_INVALID") || jsonEquals(doc["code"], "PIN_REQUIRED")) {
            detail = jsonEquals(doc["code"], "PIN_REQUIRED") ? "Card PIN required" : "Incorrect card PIN";
            return Outcome::PinRejected;
        }
        if (jsonText(doc["code"], 64)) {
            detail = "Card request rejected before payment";
            return Outcome::Rejected;
        }
    }
    return Outcome::Pending;
}

String BitposClient::callLnurlCallback(const String& callbackUrl,
                                      const String& k1, const String& bolt11,
                                      const String& pin) {
    String detail;
    const Outcome result = submitLnurlCallback(callbackUrl, k1, bolt11, pin, detail);
    // Compatibility only: acceptance is not settlement; new callers use Outcome.
    if (result == Outcome::Pending) return "Payment confirmation pending. Do not submit again.";
    return detail;
}

// ── Send mode: create a LNURL-W for outward payment ─────────────────────────
String BitposClient::createWithdraw(long amountSats,const String& pin,String& err,String& outK1,const String& requestId) {
    err="";outK1="";
    if(!validAmount(amountSats) || !digits(pin,4,6) || (!requestId.isEmpty() && !managedKey(requestId))) {err="Invalid send request";return "";}
    JsonDocument body;body["amountSats"]=amountSats;body["pin"]=pin;
    if(!requestId.isEmpty())body["requestId"]=requestId;
    size_t size=0;
    if(!encodeBody(body,size)){err="Send request too large";return "";}
    body.clear();snprintf(_urlBuf,sizeof(_urlBuf),"%s/pos/withdraw",_serverUrl.c_str());
    if(!beginAuthRequest(_urlBuf)){eraseBody();err="Secure connection unavailable";return "";}
    _authHttp.addHeader("Authorization",_authHeader);_authHttp.addHeader("Content-Type","application/json");
    const int code=_authHttp.POST(reinterpret_cast<uint8_t*>(_postBody),size);eraseBody();
    JsonDocument doc;
    if(!readResponse(_authHttp,_authClient,code) || code!=200 || !jsonObject(_respBuf,doc) ||
       !jsonKey(doc["k1"]) || !jsonText(doc["lnurlw"],1249) || (!requestId.isEmpty() && !jsonEquals(doc["k1"],requestId))) {
        err="Send authorization unavailable";return "";
    }
    outK1=doc["k1"].as<String>();return doc["lnurlw"].as<String>();
}

// ── Send mode: poll withdrawal status ─────────────────────────────────────
String BitposClient::pollWithdrawStatus(const String& k1) {
    if(!managedKey(k1))return "error";
    snprintf(_urlBuf,sizeof(_urlBuf),"%s/pos/withdraw/%s/status",_serverUrl.c_str(),k1.c_str());
    if(!beginAuthRequest(_urlBuf))return "error";
    _authHttp.addHeader("Authorization",_authHeader);
    const int code=_authHttp.GET();
    if(!readResponse(_authHttp,_authClient,code) || code!=200)return "error";
    JsonDocument doc;
    if(!jsonObject(_respBuf,doc) || !jsonEquals(doc["k1"],k1) || !jsonText(doc["status"],32))return "error";
    const String status=doc["status"].as<String>();
    if(status=="paid" || status=="failed")return status;
    if(status=="pending")return doc["dispatched"]==true || doc["phase"]=="preparing" ? "processing" : "pending";
    if((status=="cancelled" || status=="expired") && nonDispatchProof(doc))return status;
    return "error";
}

// ── Send mode: pay a bitPOS card holder directly ───────────────────────────
CardTransportPolicy::Outcome BitposClient::submitCardSend(
    const String& cardUrl, long amountSats, const String& merchantPin,
    const String& k1, String& detail) {
    detail = "Invalid card send request";
    if (!managedKey(k1) || !validAmount(amountSats) || !digits(merchantPin, 4, 6) ||
        !CardTransportPolicy::httpsUrl(cardUrl.c_str(), cardUrl.length())) return Outcome::NotSubmitted;
    JsonDocument body;
    body["k1"] = k1;
    body["cardUrl"] = cardUrl;
    body["amountSats"] = amountSats;
    body["pin"] = merchantPin;
    size_t size = 0;
    UrlBuilder url(_urlBuf, sizeof(_urlBuf));
    if (!url.add(_serverUrl.c_str()) || !url.add("/pos/send-to-card") || !encodeBody(body, size)) {
        eraseBody(); detail = "Card send request is too large"; return Outcome::NotSubmitted;
    }
    body.clear();
    if (!beginAuthRequest(_urlBuf)) {
        eraseBody(); detail = "Secure connection unavailable"; return Outcome::NotSubmitted;
    }
    _authHttp.addHeader("Authorization", _authHeader);
    _authHttp.addHeader("Content-Type", "application/json");
    const int code = _authHttp.POST(reinterpret_cast<uint8_t*>(_postBody), size);
    eraseBody();
    detail = "Send confirmation pending. Do not submit again.";
    if (!readResponse(_authHttp, _authClient, code)) return Outcome::Pending;
    JsonDocument doc;
    if (!jsonObject(_respBuf, doc) || !jsonEquals(doc["k1"], k1)) return Outcome::Pending;
    if (code == 200 && jsonEquals(doc["status"], "OK") && jsonEquals(doc["paymentStatus"], "paid") &&
        (doc["paymentHash"].isUnbound() || jsonKey(doc["paymentHash"]))) {
        detail = "Payment confirmed";
        return Outcome::Paid;
    }
    // Normal managed validation errors are pre-dispatch for this request, but
    // do not revoke the shared QR. The caller still needs proof cancellation.
    if ((code == 400 || code == 401 || code == 403 || code == 404 || code == 422) &&
        jsonText(doc["error"], 256) &&
        (doc["dispatched"].isUnbound() || nonDispatchProof(doc)) &&
        (doc["doNotRetry"].isUnbound() || (doc["doNotRetry"].is<bool>() && !doc["doNotRetry"].as<bool>()))) {
        detail = "Card send request rejected. Check withdrawal status.";
        return Outcome::Rejected;
    }
    return Outcome::Pending;
}

String BitposClient::sendToCard(const String&, long, const String&, String& err) {
    // No durable checkout ID in this legacy API. Never create an implicit
    // second checkout or start an unqueryable payment.
    err = "Update RIC firmware before sending to a card. Use QR sending on this version.";
    return err;
}

CardTransportPolicy::Outcome BitposClient::cancelManaged(const String& key, bool invoice, String& detail) {
    detail = "Invalid checkout reference";
    if (!managedKey(key)) return Outcome::NotSubmitted;
    UrlBuilder url(_urlBuf, sizeof(_urlBuf));
    detail = "Cancellation not confirmed. Keep checking payment status.";
    if (!url.add(_serverUrl.c_str()) || !url.add(invoice ? "/pos/invoice/" : "/pos/withdraw/") ||
        !url.add(key.c_str()) || !url.add("/cancel") || !beginAuthRequest(_urlBuf)) return Outcome::Pending;
    _authHttp.addHeader("Authorization", _authHeader);
    _authHttp.addHeader("Content-Type", "application/json");
    const int code = _authHttp.POST(reinterpret_cast<uint8_t*>(const_cast<char*>("{}")), 2);
#ifdef ARDUINO_ARCH_ESP32
    Serial.printf("RIC cancel transport: http=%d fd=%d wifi=%d heap=%u\n",code,_authClient.fd(),int(WiFi.status()),ESP.getFreeHeap());
#endif
    if (!readResponse(_authHttp, _authClient, code) || code != 200) return Outcome::Pending;
    JsonDocument doc;
    if (!jsonObject(_respBuf, doc) || !jsonEquals(doc[invoice ? "paymentHash" : "k1"], key) ||
        !nonDispatchProof(doc)) return Outcome::Pending;
    if (jsonEquals(doc["status"], "cancelled")) { detail = "Checkout cancelled"; return Outcome::Cancelled; }
    if (jsonEquals(doc["status"], "expired")) { detail = "Unused checkout expired"; return Outcome::Expired; }
    return Outcome::Pending;
}

CardTransportPolicy::Outcome BitposClient::cancelWithdraw(const String& k1, String& detail) {
    return cancelManaged(k1, false, detail);
}

CardTransportPolicy::Outcome BitposClient::cancelInvoice(const String& paymentHash, String& detail) {
    return cancelManaged(paymentHash, true, detail);
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
        readResponse(_authHttp, _authClient, code);
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
    readResponse(_authHttp, _authClient, code);
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
        readResponse(_authHttp, _authClient, code);
        _authHttp.end();
        if (code <= 0) _authClient.stop();
        err = "Card not found or access denied";
        return false;
    }
    readResponse(_authHttp, _authClient, code);
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
