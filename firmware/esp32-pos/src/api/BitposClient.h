#pragma once
#include <Arduino.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "../nfc/NfcWriter.h"

struct Invoice {
    String bolt11;
    String paymentHash;
    long   amountSats;
    String expiresAt;
};

class BitposClient {
public:
    // Must call init() after WiFi connects with token and server URL from NVS
    static void init(const String& serverUrl, const String& token);

    // POST /api/pos/invoice — returns bolt11 or sets err on failure
    static Invoice createInvoice(long amountSats, String& err);

    // GET /api/pos/invoice/:hash/status — returns "pending"|"paid"|"expired"
    static String pollInvoiceStatus(const String& paymentHash);

    // GET /api/price?vs_currency=xxx — returns sats per 1 fiat unit (0 on error)
    static float fetchPrice(const String& currency);

    // GET /api/pos/config — returns the merchant's display currency + send rate modifier.
    static String fetchCurrency(String& outRateModifier, String& outSendRateModifier);

    // GET /api/pos/invoice/probe/status — returns true if device token is valid
    // (non-401 = authenticated OK; 401 = token invalid/revoked)
    static bool validateToken();

    // GET /api/healthz — returns true on 200 (no auth, just connectivity)
    static bool healthCheck();

    // Generic LNURL-withdraw: GET url, parse JSON
    // Returns "" on success, error message on failure
    struct LnurlWithdraw {
        String tag;
        String callback;
        String k1;
        long   maxWithdrawable;  // msats
        String defaultDescription;
        long   pinLimitMsats;    // LUD-21: -1 = no PIN; >=0 = required when amount*1000 >= pinLimitMsats
    };
    static LnurlWithdraw fetchLnurl(const String& url, String& err);

    // Call LNURL-withdraw callback with a bolt11 (and optional PIN)
    // Returns "" on success, error reason on failure
    static String callLnurlCallback(const String& callbackUrl,
                                    const String& k1,
                                    const String& bolt11,
                                    const String& pin = "");

    // POST /api/pos/withdraw — create a LNURL-W for the merchant to send sats outward.
    // Returns the LNURL-W string (for QR display) or sets err on failure.
    // k1 is also returned so the device can poll the withdrawal status.
    static String createWithdraw(long amountSats, const String& pin, String& err, String& outK1);

    // GET /api/pos/withdraw/:k1/status — returns "pending"|"paid"|"expired"
    static String pollWithdrawStatus(const String& k1);

    // POST /api/pos/send-to-card — send sats to a bitPOS card holder.
    // The device reads the card URL (cardId + p + c) and sends it to the server,
    // which verifies the card and pays the card holder's wallet.
    // Returns "" on success, error reason on failure.
    static String sendToCard(const String& cardUrl, long amountSats,
                             const String& pin, String& err);

    // Card provisioning (write/wipe)

    // GET /api/pos/next-provision — returns pre-built NDEF + SDM + 5 keys for the
    // oldest pending card. Returns true and fills `data` on success, false on error.
    static bool fetchNextProvision(ProvisionData& data, String& err);

    // POST /api/pos/mark-written/:cardId — mark card as provisioned after write.
    static bool markCardWritten(const String& cardId, String& err);

    // GET /api/pos/wipe-keys/:cardId — returns the 5 keys + factory settings for wiping.
    static bool fetchWipeKeys(const String& cardId, WipeData& data, String& err);

    // POST /api/pos/mark-wiped/:cardId — mark card as wiped.
    static bool markCardWiped(const String& cardId, String& err);

private:
    static String _serverUrl;
    static String _token;
    static String _authHeader;

    // Pre-allocated response buffer — reserved once at init() to 1536 bytes.
    // All HTTP response bodies are read into this single buffer; subsequent
    // assignments reuse the same physical memory as long as the response fits,
    // eliminating variable-sized heap holes across hundreds of transactions.
    static String _respBuf;

    // Persistent TLS client for bitpos.app — TLS session is kept alive across
    // repeated calls via HTTPClient::setReuse(true).  Only torn down on error.
    static HTTPClient       _authHttp;
    static WiFiClientSecure _authClient;

    // Ephemeral client for third-party LNURL / card-server URLs.  A fresh TLS
    // handshake is acceptable here because these calls happen at most once per
    // transaction, not in a tight 2-second poll loop.
    static HTTPClient       _pubHttp;
    static WiFiClientSecure _pubClient;

    // Prepare an authenticated bitpos.app request.  Does NOT stop _authClient
    // so the TLS session survives across sequential calls.
    static bool beginAuthRequest(const char* url);

    // Prepare an unauthenticated request to an arbitrary host.  Always starts
    // from a clean slate (stop + reconnect) because the destination changes.
    static bool beginPubRequest(const char* url);
};
