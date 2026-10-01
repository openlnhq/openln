#pragma once
// Map NfcWriter progress labels onto the step tracker shown by CardWorkScene.
// Pure (no Arduino), so the mapping is unit-tested on the host.
//
// Issue: 0 Write data      <- "Writing NDEF..."
//        1 Authenticate    <- "Authenticating..."
//        2 Secure card     <- "Configuring SDM...", "Writing key K..."
// Wipe:  0 Read            <- (set by main before NfcWriter::wipeCard runs)
//        1 Authenticate    <- "Authenticating..."
//        2 Reset           <- "Disabling SDM...", "Resetting K..."
//        3 Erase           <- "Clearing NDEF..."
// Returns -1 for labels that do not move the tracker (e.g. the final
// "Card written"/"Card wiped", which hands over to CardDoneScene).
#include <string.h>

namespace CardSteps {

inline bool startsWith(const char* s, const char* p) {
    return s && p && strncmp(s, p, strlen(p)) == 0;
}

inline int issueStep(const char* label) {
    if (startsWith(label, "Writing NDEF"))     return 0;
    if (startsWith(label, "Authenticating"))   return 1;
    if (startsWith(label, "Configuring SDM"))  return 2;
    if (startsWith(label, "Writing key"))      return 2;
    if (startsWith(label, "Writing master"))   return 2;
    return -1;
}

inline int wipeStep(const char* label) {
    if (startsWith(label, "Reading"))          return 0;
    if (startsWith(label, "Authenticating"))   return 1;
    if (startsWith(label, "Disabling SDM"))    return 2;
    if (startsWith(label, "Resetting"))        return 2;
    if (startsWith(label, "Clearing NDEF"))    return 3;
    return -1;
}

// Never move the tracker backwards (keys K1..K0 all report step 2).
inline int advance(int current, int proposed) {
    return proposed > current ? proposed : current;
}

} // namespace CardSteps
