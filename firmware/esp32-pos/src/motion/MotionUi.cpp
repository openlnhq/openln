#include "MotionUi.h"
#include "Motion.h"
#include "CardSteps.h"

using namespace Scenes;

namespace MotionUi {

namespace {
MachineScene   g_machine;
CelebrateScene g_celebrate;
CardWorkScene  g_cardWork;
CardDoneScene  g_cardDone;
ProvisionScene g_provision;
ConnectScene   g_connect;
UpdateScene    g_update;

bool     g_machineCancel = false;
CardOp   g_cardOp = CardOp::Issue;
int      g_cardStep = 0;
}

void begin(TFT_eSPI& tft) { Motion::begin(tft); }
void stop() { Motion::stop(); }

void processing(const char* title, const char* subtitle, Mood mood, long sats, bool cancelButton) {
    Motion::Locked l;
    g_machine.set(title, subtitle, mood, sats, false, cancelButton);
    g_machineCancel = cancelButton;
    l.show(&g_machine, true);
}

void confirming(long sats, bool committed, bool stalled) {
    Motion::Locked l;
    if (stalled)
        g_machine.set("Confirming payment", "Reconnecting...", Mood::Stall, sats, committed);
    else if (committed)
        g_machine.set("Payment received", "Finishing up. Do not tap again.", Mood::Receive, sats, true);
    else
        g_machine.set("Confirming payment", "Settling over Lightning", Mood::Receive, sats, false);
    g_machineCancel = false;
    l.show(&g_machine, true);
}

void celebrate(bool sent, long sats) {
    Motion::Locked l;
    g_celebrate.set(sent ? Celebration::Sent : Celebration::Received, sats,
                    sent ? "Payment sent" : "Payment received");
    l.show(&g_celebrate, false);
}

bool cancelHit(int tx, int ty) {
    if (!g_machineCancel || Motion::current() != &g_machine) return false;
    return tx >= MachineScene::CANCEL_X - 4 && tx < MachineScene::CANCEL_X + MachineScene::CANCEL_W + 4 &&
           ty >= MachineScene::CANCEL_Y - 4 && ty < MachineScene::CANCEL_Y + MachineScene::CANCEL_H + 4;
}

void cardWork(CardOp op) {
    Motion::Locked l;
    g_cardOp = op;
    g_cardStep = 0;
    g_cardWork.set(op);
    g_cardWork.setStep(0);
    l.show(&g_cardWork, false);
}

void cardStep(int step) {
    g_cardStep = CardSteps::advance(g_cardStep, step);
    g_cardWork.setStep(g_cardStep);   // plain int store; read by the render task
}

void cardStepLabel(const char* label) {
    const int s = g_cardOp == CardOp::Issue ? CardSteps::issueStep(label) : CardSteps::wipeStep(label);
    if (s >= 0) cardStep(s);
}

void cardDone(CardOp op) {
    Motion::Locked l;
    // NfcWriter's "done" step starts the finale; ResultScreen's success draw
    // that follows the server bookkeeping must not restart it.
    if (Motion::current() == &g_cardDone && g_cardDone.op() == op) return;
    g_cardDone.set(op);
    l.show(&g_cardDone, false);
}

void cardFinish() { cardDone(g_cardOp); }

void provision(const char* deviceName) {
    Motion::Locked l;
    g_provision.set(deviceName);
    l.show(&g_provision, true);
}

void connect(LinkPhase phase, const char* title, const char* detail, bool cancelButton) {
    Motion::Locked l;
    g_connect.set(phase, title, detail, cancelButton);
    l.show(&g_connect, true);
}

void update(UpdatePhase phase, const char* title, const char* detail, const char* footer) {
    Motion::Locked l;
    const bool restart = Motion::current() != &g_update || g_update.phase() != phase;
    g_update.set(phase, title, detail, footer);
    l.show(&g_update, !restart);
}

void updatePercent(int percent) { g_update.setPercent(percent); }

uint32_t chimeDelayMs() {
    Motion::Locked l;
    Scene* s = Motion::current();
    if (!s || !s->chimeAt()) return 0;
    const uint32_t el = Motion::elapsedMs();
    return s->chimeAt() > el ? s->chimeAt() - el : 0;
}

} // namespace MotionUi
