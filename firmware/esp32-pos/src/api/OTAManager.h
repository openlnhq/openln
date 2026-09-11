#pragma once
#include <Arduino.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Update.h>
#include "../config/Config.h"
#include "../ui/Theme.h"

// FIRMWARE_VERSION is a #define in main.cpp, included via the build
#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "0.0.0"
#endif

/**
 * OTA updater — checks the server for firmware updates and installs them.
 *
 * Flow:
 * 1. GET /api/firmware/posbox-version → { version, url }
 * 2. Compare version with FIRMWARE_VERSION
 * 3. If different, download the app-only binary from url
 * 4. Flash to inactive OTA slot via Update::write()
 * 5. ESP.restart() — bootloader swaps to the new slot
 *
 * Called once on boot after WiFi connects. Non-blocking relative to the
 * main loop — takes 10-30s to download + flash.
 */

class OTAManager {
public:
    // Check for update and install if available.
    // Returns true if an update was installed (device will reboot).
    // Returns false if no update or check failed.
    static bool checkAndUpdate(TFT_eSPI& tft) {
        WiFiClientSecure client;
        client.setInsecure();
        HTTPClient http;

        String url = Config::serverUrl + "/firmware/posbox-version";
        DBG_PRINTF("OTA: checking %s\n", url.c_str());

        if (!http.begin(client, url)) {
            DBG_PRINTLN("OTA: connection failed");
            return false;
        }
        http.addHeader("Authorization", "Bearer " + Config::token);
        int code = http.GET();
        DBG_PRINTF("OTA: HTTP %d\n", code);

        if (code != 200) {
            http.end();
            return false;
        }

        String response = http.getString();
        http.end();

        // Parse { "version": "1.0.1", "url": "https://bitpos.app/firmware/posbox-ota.bin" }
        int vStart = response.indexOf("\"version\"");
        int uStart = response.indexOf("\"url\"");
        if (vStart < 0 || uStart < 0) {
            DBG_PRINTLN("OTA: invalid response");
            return false;
        }

        // Extract version
        vStart = response.indexOf("\"", vStart + 9) + 1;
        int vEnd = response.indexOf("\"", vStart);
        String serverVersion = response.substring(vStart, vEnd);

        // Extract URL
        uStart = response.indexOf("\"", uStart + 6) + 1;
        int uEnd = response.indexOf("\"", uStart);
        String firmwareUrl = response.substring(uStart, uEnd);

        DBG_PRINTF("OTA: server=%s device=%s\n", serverVersion.c_str(), FIRMWARE_VERSION);

        if (serverVersion == String(FIRMWARE_VERSION)) {
            DBG_PRINTLN("OTA: up to date");
            return false;
        }

        DBG_PRINTF("OTA: update available → %s\n", firmwareUrl.c_str());

        // Show updating screen
        tft.fillScreen(COL_BG);
        tft.setTextDatum(MC_DATUM);
        tft.setTextFont(FONT_MED);
        tft.setTextColor(COL_ACCENT, COL_BG);
        tft.drawString("Updating...", SCREEN_W / 2, SCREEN_H / 2 - 20);
        tft.setTextFont(FONT_SMALL);
        tft.setTextColor(COL_MUTED, COL_BG);
        tft.drawString("Do not power off", SCREEN_W / 2, SCREEN_H / 2 + 20);

        // Download and flash
        WiFiClientSecure dlClient;
        dlClient.setInsecure();
        HTTPClient dlHttp;

        if (!dlHttp.begin(dlClient, firmwareUrl)) {
            DBG_PRINTLN("OTA: download connection failed");
            return false;
        }
        code = dlHttp.GET();
        DBG_PRINTF("OTA: download HTTP %d\n", code);

        if (code != 200) {
            dlHttp.end();
            return false;
        }

        int contentLength = dlHttp.getSize();
        DBG_PRINTF("OTA: firmware size=%d\n", contentLength);

        if (contentLength <= 0) {
            dlHttp.end();
            return false;
        }

        if (!Update.begin(contentLength)) {
            DBG_PRINTLN("OTA: Update.begin failed");
            dlHttp.end();
            return false;
        }

        // Write the firmware in chunks
        WiFiClient* stream = dlHttp.getStreamPtr();
        uint8_t buf[1024];
        int written = 0;
        int lastProgress = -1;

        while (dlHttp.connected() && written < contentLength) {
            size_t avail = stream->available();
            if (avail == 0) {
                delay(10);
                continue;
            }

            int readLen = stream->readBytes(buf, (avail < sizeof(buf)) ? avail : sizeof(buf));
            if (readLen <= 0) break;

            Update.write(buf, readLen);
            written += readLen;

            int progress = (written * 100) / contentLength;
            if (progress != lastProgress && progress % 10 == 0) {
                DBG_PRINTF("OTA: %d%%\n", progress);
                lastProgress = progress;
                // Update progress on screen
                tft.setTextFont(FONT_SMALL);
                tft.setTextColor(COL_MUTED, COL_BG);
                char pbuf[8];
                snprintf(pbuf, sizeof(pbuf), "%d%%", progress);
                tft.drawString(pbuf, SCREEN_W / 2, SCREEN_H / 2 + 50);
            }

            esp_task_wdt_reset();
        }

        if (written == contentLength && Update.end()) {
            DBG_PRINTLN("OTA: update complete — rebooting");
            dlHttp.end();

            tft.fillScreen(COL_SUCCESS);
            tft.setTextDatum(MC_DATUM);
            tft.setTextFont(FONT_MED);
            tft.setTextColor(COL_TEXT, COL_SUCCESS);
            tft.drawString("Updated", SCREEN_W / 2, SCREEN_H / 2 - 10);
            tft.setTextFont(FONT_SMALL);
            tft.drawString("Rebooting...", SCREEN_W / 2, SCREEN_H / 2 + 20);

            delay(2000);
            ESP.restart();
            return true;
        } else {
            DBG_PRINTF("OTA: failed — written=%d expected=%d\n", written, contentLength);
            Update.abort();
            dlHttp.end();
            return false;
        }
    }
};
