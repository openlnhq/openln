#include <TFT_eSPI.h>
#include "screens/PaymentScreen.h"
#include "screens/PinScreen.h"
#include "ui/Numpad.h"
#include "ui/Theme.h"
#include <fstream>
#include <iostream>
#include <numeric>

static std::filesystem::path output;
static std::vector<std::string> scenes;
static int fixtureId = 0;
static String fixture(size_t length = 300) {
    // Deliberately synthetic, non-payable alphanumeric test data. No network use.
    std::string value = "lnbc10n1";
    const std::string alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    while (value.size() < length) value += alphabet;
    value.resize(length);
    value += std::to_string(++fixtureId);
    return value;
}
static void save(TFT_eSPI& tft, const std::string& name) {
    tft.save(output, name); scenes.push_back(name);
}
static int timerSeconds(const std::string& text) {
    int minutes = -1, seconds = -1;
    if (std::sscanf(text.c_str(), "%d:%d", &minutes, &seconds) != 2) return -1;
    return minutes * 60 + seconds;
}
static void array(std::ostream& out, const std::vector<int>& values) {
    out << '[';
    for (size_t i = 0; i < values.size(); ++i) { if (i) out << ','; out << values[i]; }
    out << ']';
}

int main(int argc, char** argv) {
    try {
        if (argc != 2 && argc != 4)
            throw std::runtime_error("usage: ric-display-host OUTPUT_DIRECTORY [--dense PAYLOAD_LENGTH]");
        output = argv[1]; std::filesystem::create_directories(output);
        if (argc == 4) {
            if (std::string(argv[2]) != "--dense") throw std::runtime_error("expected --dense");
            int length = std::stoi(argv[3]);
            if (length < 1 || length > 4096) throw std::runtime_error("dense length out of range");
            // Isolated process: a dependency overflow must not discard normal renders.
            TFT_eSPI dense; host::resetClock(10000); host::qr = {};
            String payload = fixture(length).substring(0, length);
            std::cerr << "PaymentScreen::draw synthetic payload length=" << payload.length() << '\n';
            PaymentScreen::draw(dense, payload, 987654, "100.00 ZAR", 60);
            save(dense, "payment-dense");
            std::cout << "Dense render returned; QR version=" << host::qr.version << '\n';
            return 0;
        }
        std::ofstream report(output / "native.json");
        report << '{';

        // End-to-end countdown assertion uses displayed text, not private methods.
        const uint32_t start = UINT32_MAX - 4999U;
        const std::vector<int> elapsed = {0, 1, 999, 1000, 4999, 5000, 55000, 59000, 59999, 60000, 61000};
        std::vector<int> actual, expected;
        TFT_eSPI rollover;
        host::resetClock(start);
        PaymentScreen::draw(rollover, fixture(), 250, "5.00 THB", 60);
        save(rollover, "payment-rollover-start");
        for (int delta : elapsed) {
            host::nowMs = start + static_cast<uint32_t>(delta);
            PaymentScreen::update(rollover);
            actual.push_back(timerSeconds(rollover.lastTimer()));
            expected.push_back(std::max(0, (60000 - delta + 999) / 1000));
        }
        report << "\"rollover\":{\"startMs\":" << start << ",\"elapsedMs\":"; array(report, elapsed);
        report << ",\"actualSeconds\":"; array(report, actual);
        report << ",\"expectedSeconds\":"; array(report, expected); report << "},";

        // Same-invoice redraw must preserve its original on-screen deadline.
        TFT_eSPI resume; host::resetClock(1000);
        const String invoice = fixture();
        PaymentScreen::draw(resume, invoice, 250, "5.00 THB", 60);
        host::nowMs = 22000;
        PaymentScreen::draw(resume, invoice, 250, "5.00 THB", 60);
        int same = timerSeconds(resume.lastTimer());
        PaymentScreen::draw(resume, fixture(), 250, "5.00 THB", 60);
        int fresh = timerSeconds(resume.lastTimer());
        report << "\"invoiceDeadline\":{\"sameInvoiceSeconds\":" << same << ",\"newInvoiceSeconds\":" << fresh << "},";

        struct PaymentCase { const char* name; const char* fiat; long sats; size_t qrLength; };
        for (const auto& item : std::vector<PaymentCase>{
            {"payment-small", "5.00 THB", 250, 300},
            {"payment-14ch", "999,999.99 THB", 2147483647L, 300},
            {"payment-large", "9,999,999.99 THB", 2147483647L, 300},
        }) {
            TFT_eSPI screen; host::resetClock(10000);
            PaymentScreen::draw(screen, fixture(item.qrLength), item.sats, item.fiat, 600);
            save(screen, item.name);
            if (std::string(item.name) == "payment-small") {
                PaymentScreen::showCardDetected(screen); save(screen, "payment-card-detected");
                host::nowMs += 591000U; PaymentScreen::update(screen); save(screen, "payment-countdown-warning");
            }
        }

        host::qr = {};
        for (int length : {4, 6}) {
            TFT_eSPI screen; host::resetClock(10000);
            PinScreen::draw(screen, "host-test-card", length);
            save(screen, "pin-" + std::to_string(length));
        }

        TFT_eSPI processing; host::resetClock(10000);
        int delayFrame = 0;
        host::delayObserver = [&](uint32_t) { save(processing, "pin-processing-wait-" + std::to_string(delayFrame++)); };
        PinScreen::drawProcessing(processing);
        host::delayObserver = {};
        save(processing, "pin-processing");
        const auto waits = host::delays;
        report << "\"processing\":{\"delayCalls\":[";
        for (size_t i = 0; i < waits.size(); ++i) { if (i) report << ','; report << waits[i]; }
        report << "],\"blockedMs\":" << std::accumulate(waits.begin(), waits.end(), uint64_t(0)) << "},";

        TFT_eSPI confirming; host::resetClock(10000);
        PinScreen::drawConfirming(confirming); save(confirming, "pin-confirming");
        host::nowMs += 450; PinScreen::updateConfirming(confirming); save(confirming, "pin-confirming-next");
        report << "\"confirming\":{\"delayCalls\":" << host::delays.size() << "},";

        // Exercise the actual PinScreen/Numpad hit testing. Locate keys from the
        // real drawn text rectangles so UI layout changes do not require new coordinates.
        std::vector<int> pinReturns, pinLengths;
        for (int length : {4, 6}) {
            TFT_eSPI screen; PinScreen::draw(screen, "host-test-card", length);
            host::Rect one;
            for (const auto& op : screen.operations) if (op.kind == "text" && op.text == "1") one = op.rect;
            if (!one.w) throw std::runtime_error("real numpad has no visible 1 key");
            char result = 0;
            for (int i = 0; i < length; ++i)
                result = PinScreen::handleTouch(screen, one.x + one.w / 2, one.y + one.h / 2);
            pinReturns.push_back(result); pinLengths.push_back(PinScreen::getPin().length());
            save(screen, "pin-" + std::to_string(length) + "-complete");
        }
        report << "\"pinInput\":{\"returnCodes\":"; array(report, pinReturns);
        report << ",\"lengths\":"; array(report, pinLengths); report << "},";

        TFT_eSPI fonts; host::qr = {}; fonts.fillScreen(TFT_BLACK);
        fonts.setTextColor(TFT_WHITE, TFT_BLACK); fonts.setTextDatum(TL_DATUM);
        fonts.drawString("0", 10, 10, 2); fonts.drawString("0", 40, 10, 4);
        fonts.drawString("RIC 0123456789", 10, 60, 2);
        fonts.drawString("RIC 0123456789", 10, 100, 4);
        fonts.drawString("0", 10, 155, 6);
        save(fonts, "font-proof");
        report << "\"fontMetrics\":{\"font2\":{\"zeroWidth\":" << fonts.textWidth("0", 2)
               << ",\"height\":" << fonts.fontHeight(2) << "},\"font4\":{\"zeroWidth\":" << fonts.textWidth("0", 4)
               << ",\"height\":" << fonts.fontHeight(4) << "}},";
        report << "\"scenes\":[";
        for (size_t i = 0; i < scenes.size(); ++i) { if (i) report << ','; report << host::jsonQuote(scenes[i]); }
        report << "]}\n";
        if (!report) throw std::runtime_error("failed to write native report");
        std::cout << "Native firmware scenarios completed: " << scenes.size() << "\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "ric-display: " << error.what() << '\n'; return 1;
    }
}
