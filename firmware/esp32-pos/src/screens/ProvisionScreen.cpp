#include "ProvisionScreen.h"
#include "../motion/MotionUi.h"
#include "../ble/ProvisionService.h"

// BLE provisioning: radar beacon with the Bluetooth rune, this unit's
// Bluetooth name large (so it can be picked out of a chooser that lists every
// terminal in range) and the pairing instructions. Animated by the Motion
// engine; see ProvisionScene in motion/Scenes.cpp.
void ProvisionScreen::draw(TFT_eSPI& tft) {
    (void)tft;
    MotionUi::provision(ProvisionService::deviceName().c_str());
}

// The render task animates the beacon; nothing to do per loop iteration.
void ProvisionScreen::update(TFT_eSPI& tft) { (void)tft; }
