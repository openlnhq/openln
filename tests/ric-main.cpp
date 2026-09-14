#include "ric-main-shim/Harness.h"

// Compile EVERY line of the selected actual firmware src/main.cpp. The runner
// copies it byte-for-byte to an isolated include site solely so quoted hardware
// includes resolve to explicit test shims. No regex/extracted state machine.
namespace ric_main {
#include RIC_MAIN_SOURCE
}

namespace test {
using namespace RicMainShim;
namespace app=ric_main;
inline void require(bool ok,const std::string& message){if(!ok)throw std::runtime_error(message);}
inline void tick(uint32_t step=50){now+=step;RicIoWorker::pump();app::loop();}
inline void ticks(unsigned n,uint32_t step=50){while(n--)tick(step);}
template<class Predicate> void until(Predicate predicate,unsigned limit=160,uint32_t step=50){
    for(unsigned i=0;i<limit && !predicate();++i)tick(step);
    require(predicate(),"scenario did not reach expected state; state="+std::to_string(app::state));
}
inline void boot(){app::setup();until([]{return app::state==app::STATE_IDLE_AMOUNT;});}
inline void receive(){
    boot();app::currentAmountSats=amount;app::state=app::STATE_CREATING_INVOICE;
    until([]{return app::state==app::STATE_WAITING_PAYMENT;});
    require(count("createInvoice")==1,"receive must originate from actual create-invoice handler");
}
inline void tap(char action=0){
    touched=false;tick(250);pinAction=action;touched=true;tick(250);touched=false;tick(250);
}
inline void frozenTls(){
    receive();strictIo=true;RicIoWorker::gateNetwork=true;
    app::lastStatusPoll=millis()-3000;
    const auto frames=displayWrites, feeds=watchdogFeeds;
    const auto before=millis();
    ticks(40);
    require(RicIoWorker::anyBusy(),"TLS completion gate never held a real-main submitted job");
    require(displayWrites>frames+20,"payment UI did not advance while TLS completion was held");
    require(watchdogFeeds>=feeds+40,"watchdog/loop stopped while TLS completion was held");
    require(millis()-before<=5000,"UI loop accumulated blocking delays while TLS was gated");
    require(count("pollInvoiceStatus")==0,"gated TLS request unexpectedly completed");
    RicIoWorker::gateNetwork=false;
    until([]{return count("pollInvoiceStatus")>0;});
    require(last("pollInvoiceStatus").key==paymentHash.c_str(),"status poll lost invoice hash");
}
inline void frozenNfc(){
    receive();strictIo=true;RicIoWorker::gateNfc=true;card();
    const auto frames=displayWrites, feeds=watchdogFeeds;
    ticks(40);
    require(RicIoWorker::anyBusy(),"NFC completion gate never held a real-main submitted job");
    require(displayWrites>frames+20,"payment UI froze while NFC completion was held");
    require(watchdogFeeds>=feeds+40,"loop/watchdog stopped while NFC completion was held");
    // Cancel may intentionally be disabled while RF ownership is in flight.
    require(count("readNdef")==0,"gated NFC read unexpectedly completed");
    RicIoWorker::gateNfc=false;
    until([]{return count("readNdef")>0;});
}
inline void callbackPaidOnly(){
    receive();card();until([]{return count("callback")==1;});ticks(5);
    require(successDraws==0,"callback acceptance was incorrectly treated as settlement");
    require(count("callback")==1,"callback was duplicated before settlement");
    invoiceStatus="paid";
    until([]{return successDraws>0;},200,500);
    require(last("pollInvoiceStatus").key==paymentHash.c_str(),"settlement queried a different invoice");
}
inline void callbackTimeoutOnce(){
    receive();callbackError="Network timeout: outcome unknown";callbackKind="unknown";
    invoiceStatus="unknown";card();until([]{return count("callback")==1;});ticks(5);
    // Payment may already have reached the card's server. Exercise timeout,
    // retry/cancel/confirm gestures and another tap, not just a passive count.
    now=app::invoiceCreateTime+600001;tick();
    resultDismiss=true;paymentCancel=true;card("repeat");pinValue="1234";tap('O');
    if(app::state==app::STATE_IDLE_AMOUNT){payTouch=true;tap();}
    ticks(40,1000);
    require(count("callback")==1,"uncertain callback was sent more than once");
    require(count("createInvoice")==1,"timeout/retry replaced an unresolved invoice");
    require(app::currentInvoice.paymentHash==paymentHash,"callback timeout forgot original payment hash");
    CheckoutJournal::Record record{};
    require(CheckoutJournal::load(record)==CheckoutJournal::LoadResult::Valid,"uncertain callback lost durable reconciliation identity");
    require(String(record.reference)==paymentHash,"uncertain callback journal changed invoice");
    require(count("pollInvoiceStatus")>0,"uncertain callback stopped status reconciliation");
}
inline void wifiPreservesHash(){
    receive();card();until([]{return count("callback")==1;});
    const auto created=count("createInvoice");
    WiFi.connection=WL_DISCONNECTED;tick();ticks(8,1000);
    const auto previousPolls=count("pollInvoiceStatus");
    WiFi.connection=WL_CONNECTED;resultDismiss=true;tap();
    until([&]{return count("pollInvoiceStatus")>previousPolls;},200,500);
    require(app::currentInvoice.paymentHash==paymentHash,"WiFi reconnect replaced the payment hash");
    invoiceStatus="paid";until([]{return successDraws>0;},200,500);
    require(count("createInvoice")==created && count("callback")==1,"WiFi recovery dispatched a replacement payment");
    require(last("pollInvoiceStatus").key==paymentHash.c_str(),"WiFi recovery queried a different hash");
}
inline void bootQueryOnly(bool withdraw,bool dispatched){
    const String key=withdraw?withdrawK1:paymentHash;
    const auto kind=withdraw?CheckoutJournal::Kind::Withdraw:CheckoutJournal::Kind::Receive;
    require(CheckoutJournal::save(kind,key.c_str(),amount,dispatched),"journal fixture could not be seeded");
    FakeNvs::reboot();app::setup();
    const std::string poll=withdraw?"pollWithdrawStatus":"pollInvoiceStatus";
    for(unsigned i=0;i<100 && !count(poll);++i)tick(500);
    require(count(poll)>0,"boot ignored a saved checkout instead of querying its status");
    require(last(poll).key==key.c_str(),"boot recovery queried a different journal identity");
    require(count("createInvoice")==0 && count("createWithdraw")==0 && count("callback")==0 && count("sendToCard")==0,
        "boot recovery dispatched a payment instead of query-only recovery");
    require(otaChecks==0 && priceCalls==0,"boot ran OTA/price maintenance before unresolved recovery");
    require(app::state!=app::STATE_IDLE_AMOUNT,"boot enabled new checkout before saved payment resolved");
    if(withdraw)withdrawStatus="paid";else invoiceStatus="paid";
    until([]{return successDraws>0;},160,1000);
    CheckoutJournal::Record record{};
    require(CheckoutJournal::load(record)==CheckoutJournal::LoadResult::Missing,"confirmed paid recovery did not clear journal");
}
inline void receiveWindow(){receive();require(lastTtl==600,"receive presentation window must be 600 seconds, got "+std::to_string(lastTtl));}
inline void receiveExpiry(bool viaCard){
    receive();
    if(viaCard){card();until([]{return count("callback")==1;});}
    // QR can also have been scanned while the device sees only network errors.
    // A local timer is not an authoritative negative payment result.
    invoiceStatus="error";now=app::invoiceCreateTime+600001;tick();ticks(16,10000);
    require(app::state!=app::STATE_IDLE_AMOUNT,"600-second timeout abandoned a possibly charged receive");
    require(app::currentInvoice.paymentHash==paymentHash,"receive expiration forgot its payment hash");
    CheckoutJournal::Record record{};
    require(CheckoutJournal::load(record)==CheckoutJournal::LoadResult::Valid,"receive expiration erased unresolved journal");
    require(String(record.reference)==paymentHash,"receive expiration journal contains a different hash");
    resultDismiss=true;paymentCancel=true;tap();
    require(app::state!=app::STATE_IDLE_AMOUNT,"dismiss/cancel forgot a possibly paid expired receive");
    invoiceStatus="paid";until([]{return successDraws>0;},160,1000);
    require(count("createInvoice")==1 && count("callback")==size_t(viaCard),"receive reconciliation resent a payment");
}
inline void typedPinRetry(){
    receive();pinLimitMsats=0;invoiceStatus="unknown";
    callbackKind="wrong_pin";callbackError="Credential rejected"; // No PIN substring: typed result is mandatory.
    lnurlK1s={cardK1, String("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")};
    card("first-challenge");until([]{return app::state==app::STATE_PIN_ENTRY;});
    pinValue="0000";tap('O');until([]{return count("callback")==1;});ticks(5);
    require(app::state==app::STATE_PIN_ENTRY || app::state==app::STATE_WAITING_PAYMENT,
        "typed PIN rejection became a terminal/uncertain lock instead of safe retry");
    if(app::state==app::STATE_PIN_ENTRY)tap('C');
    until([]{return app::state==app::STATE_WAITING_PAYMENT;});
    const auto pollsBeforeRetry=count("pollInvoiceStatus");
    ticks(35,100); // force an invoice status 'unknown' between challenges
    require(count("pollInvoiceStatus")>pollsBeforeRetry,"fixture never delivered server unknown between PIN challenges");
    require(app::state==app::STATE_WAITING_PAYMENT,"server unknown prevented safe new challenge after typed rejection");
    callbackKind="accepted";callbackError="";card("second-challenge");
    until([]{return app::state==app::STATE_PIN_ENTRY;});
    require(count("fetchLnurl")==2,"typed PIN retry did not fetch a new NFC challenge");
    pinValue="1234";tap('O');until([]{return count("callback")==2;});
    require(last("callback").pin=="1234","retry lost the newly typed PIN");
    require(last("callback").key=="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "new NFC challenge reused a rejected/obsolete k1");
    invoiceStatus="paid";until([]{return successDraws>0;},160,500);
    require(count("createInvoice")==1,"PIN rejection replaced the invoice instead of retrying the card challenge");
}
inline void sendSharedK1(){
    boot();sendMode=true;app::currentAmountSats=amount;app::state=app::STATE_SEND_PIN_ENTRY;
    pinValue="123456";tap('O');until([]{return app::state==app::STATE_SEND_WAITING;});
    require(lastQr==withdrawQr && app::sendK1==withdrawK1,"send did not display the actual createWithdraw result");
    require(count("createWithdraw")==1,"send must create exactly one QR withdrawal");
    card("send-card");until([]{return count("sendToCard")>0;});
    require(last("sendToCard").key==withdrawK1.c_str(),"NFC send did not claim the SAME k1 as the displayed QR");
    require(last("sendToCard").journalValid && last("sendToCard").journalReference==withdrawK1.c_str(),
        "NFC send dispatched before the QR withdrawal identity was journaled");
    withdrawStatus="paid";until([]{return successDraws>0;},160,500);
    require(count("createWithdraw")==1 && count("sendToCard")==1,"QR/NFC race created a duplicate withdrawal");
}
inline void bootJournalFault(bool unavailable){
    require(CheckoutJournal::save(CheckoutJournal::Kind::Withdraw,withdrawK1.c_str(),amount,true),"could not seed faulted journal");
    if(unavailable)FakeNvs::state().openError=ESP_FAIL;
    else FakeNvs::active().bytes[30]^=1; // Real CRC corruption, not a fake load-result override.
    const auto bytes=FakeNvs::active().bytes;
    FakeNvs::reboot();app::setup();ticks(20,500);
    sendMode=true;pinValue="123456";payTouch=true;resultDismiss=true;paymentCancel=true;tap('O');ticks(20,500);
    require(count("createInvoice")==0 && count("createWithdraw")==0 && count("sendToCard")==0 && count("callback")==0,
        "faulted journal allowed a new payment instead of failing closed");
    require(otaChecks==0 && priceCalls==0,"faulted journal boot ran maintenance instead of preserving operator lock");
    require(count("pollInvoiceStatus")==0 && count("pollWithdrawStatus")==0,"faulted journal was used as a valid query capability");
    require(FakeNvs::active().bytes==bytes && FakeNvs::state().erases==0,"faulted journal was silently discarded");
    require(app::state!=app::STATE_IDLE_AMOUNT,"faulted journal boot presented new-checkout idle state");
}
inline void invoiceJournalSaveFailure(){
    boot();FakeNvs::state().setError=ESP_FAIL;
    app::currentAmountSats=amount;app::state=app::STATE_CREATING_INVOICE;
    until([]{return count("createInvoice")==1;});ticks(5);
    require(lastQr.isEmpty(),"failed journal write nevertheless exposed a receive QR");
    require(app::currentInvoice.paymentHash==paymentHash,"failed journal write discarded the known invoice hash");
    until([]{return count("pollInvoiceStatus")>0;},160,500);
    require(last("pollInvoiceStatus").key==paymentHash.c_str(),"storage fault polled a different invoice");
    sendMode=true;pinValue="123456";payTouch=true;resultDismiss=true;tap('O');ticks(20,500);
    require(count("createInvoice")==1 && count("createWithdraw")==0 && count("callback")==0 && count("sendToCard")==0,
        "storage fault allowed a replacement/new outbound payment");
    require(lastQr.isEmpty(),"storage fault exposed a QR during recovery");
}
inline void workerAllocationFailure(bool nfc){
    RicIoWorker::failNetworkBegin=!nfc;RicIoWorker::failNfcBegin=nfc;
    app::setup();ticks(20,100);
    sendMode=true;payTouch=true;resultDismiss=true;tap();pinValue="123456";tap('O');ticks(20,100);
    require(count("createInvoice")==0 && count("createWithdraw")==0 && count("callback")==0 && count("sendToCard")==0,
        "worker allocation failure fell back to inline or partial payment execution");
    require(RicIoWorker::startCount()==0,"missing I/O worker did not block checkout submission");
}
inline void openSend(){
    boot();sendMode=true;app::currentAmountSats=amount;app::state=app::STATE_SEND_PIN_ENTRY;
    pinValue="123456";tap('O');until([]{return app::state==app::STATE_SEND_WAITING;});
}
inline void cancelRetryAfterPending(){
    openSend();withdrawStatus="pending";cancelKinds={String("pending"),String("cancelled")};
    paymentCancel=true;tap();until([]{return count("cancelWithdraw")>=1;});
    CheckoutJournal::Record record{};
    require(CheckoutJournal::load(record)==CheckoutJournal::LoadResult::Valid,"lost cancellation response erased recovery identity");
    const auto polls=count("pollWithdrawStatus");
    until([]{return count("cancelWithdraw")==2;},160,500);
    require(count("pollWithdrawStatus")>polls,"cancellation retry was not preceded by authoritative pending status");
    require(last("cancelWithdraw").key==withdrawK1.c_str(),"cancellation retry changed the withdrawal key");
    require(count("createWithdraw")==1 && count("sendToCard")==0 && count("callback")==0,
        "safe cancellation retry became a payment retry");
    ticks(3);
    require(CheckoutJournal::load(record)==CheckoutJournal::LoadResult::Missing,"confirmed repeated cancellation did not clear journal");
    require(count("cancelWithdraw")==2,"cancellation continued after definitive terminal proof");
}
inline void sendTimeoutOnce(){
    openSend();sendKind="pending";sendError="Response lost after possible send";withdrawStatus="pending";
    card("send-first");until([]{return count("sendToCard")==1;});ticks(3);
    const auto key=last("sendToCard").key;
    now=app::invoiceCreateTime+600001;tick();
    paymentCancel=true;resultDismiss=true;payTouch=true;card("send-repeat");tap('O');ticks(30,1000);
    require(count("createWithdraw")==1 && count("sendToCard")==1,"uncertain card send was dispatched twice");
    CheckoutJournal::Record record{};
    require(CheckoutJournal::load(record)==CheckoutJournal::LoadResult::Valid && record.reference==key,
        "uncertain outbound send lost durable identity");
    require(count("pollWithdrawStatus")>0 && last("pollWithdrawStatus").key==key,"outbound timeout stopped same-key status reconciliation");
    withdrawStatus="paid";until([]{return successDraws>0;},160,1000);
}
inline void pinTimeoutIsNotRejection(){
    receive();pinLimitMsats=0;invoiceStatus="unknown";
    callbackKind="unknown";callbackError="PIN verifier request timed out";
    card();until([]{return app::state==app::STATE_PIN_ENTRY;});
    pinValue="1234";tap('O');until([]{return count("callback")==1;});ticks(8);
    pinValue="1234";tap('O');ticks(40,500);
    require(wrongPins==0,"ambiguous timeout text was mistaken for a typed PIN rejection");
    require(count("callback")==1,"PIN timeout reopened the challenge and sent another callback");
    require(app::state!=app::STATE_IDLE_AMOUNT && count("pollInvoiceStatus")>0,
        "ambiguous PIN callback lost status reconciliation");
}
inline void cancelWhileDetecting(){
    receive();RicIoWorker::gateNfc=true;card("late-detect");ticks(3);
    require(RicIoWorker::anyBusy(),"scenario did not hold an NFC detection job");
    const auto detects=count("detectCard");
    cancelKind="cancelled";paymentCancel=true;tap();ticks(5);
    require(count("cancelInvoice")==1,"Cancel was ignored while NFC detection was in flight");
    require(last("cancelInvoice").key==paymentHash.c_str(),"cancel request targeted a different invoice");
    require(count("detectCard")==detects,"test released the NFC gate before cancellation was accepted");
    CheckoutJournal::Record record{};
    require(CheckoutJournal::load(record)==CheckoutJournal::LoadResult::Missing,
        "definitive cancellation did not clear the exact target journal");
    const auto ota=otaChecks,hello=helloCalls,price=priceCalls,reinit=nfcReinits;
    app::lastHelloAt=millis()-300001;app::priceLastFetched=millis()-300001;app::nextOtaCheck=millis()-1;
    payTouch=true;tap();ticks(5);payTouch=false;
    require(otaChecks==ota && helloCalls==hello && priceCalls==price && nfcReinits==reinit,
        "maintenance ran after cancellation but before NFC worker relinquished ownership");
    require(count("createInvoice")==1,"next checkout overwrote a still-owned NFC job context");
    RicIoWorker::gateNfc=false;ticks(5);
    require(count("readNdef")==0 && count("fetchLnurl")==0 && count("callback")==0,
        "late NFC detection result resurrected a cancelled checkout");
}
inline void journalBeforeExpose(){
    receive();require(journalWritesAtQr>0,"receive QR was shown before its recovery identity was persisted");
    card();until([]{return count("callback")==1;});
    const auto& callback=last("callback");
    require(callback.journalValid && callback.dispatched && callback.journalReference==paymentHash.c_str(),
        "LNURL callback was dispatched before its durable attempted marker");
}
inline void maintenanceGate(){
    receive();RicIoWorker::gateNfc=true;strictIo=true;card();ticks(5);
    const auto ota=otaChecks,hello=helloCalls,price=priceCalls,reinit=nfcReinits;
    app::lastHelloAt=millis()-300001;app::priceLastFetched=millis()-300001;app::nextOtaCheck=millis()-1;
    paymentCancel=true;tap();ticks(10);
    require(otaChecks==ota && helloCalls==hello && priceCalls==price && nfcReinits==reinit,
        "checkout IO still owned context but idle maintenance began");
    require(RicIoWorker::anyBusy(),"gate was bypassed instead of holding the outstanding NFC operation");
}
inline std::string quote(const std::string& value){
    std::ostringstream out;out<<'"';for(unsigned char c:value){switch(c){case '\\':out<<"\\\\";break;case '"':out<<"\\\"";break;case '\n':out<<"\\n";break;case '\r':out<<"\\r";break;case '\t':out<<"\\t";break;default:if(c<32)out<<"\\u"<<std::hex<<std::setw(4)<<std::setfill('0')<<unsigned(c)<<std::dec;else out<<c;}}out<<'"';return out.str();
}
inline void report(const std::string& scenario,bool passed,const std::string& error){
    CheckoutJournal::Record record{};const auto journal=CheckoutJournal::load(record);
    std::cout<<"{\"scenario\":"<<quote(scenario)<<",\"passed\":"<<(passed?"true":"false")<<",\"error\":"<<quote(error)
        <<",\"state\":"<<app::state<<",\"virtualMs\":"<<millis()<<",\"displayWrites\":"<<displayWrites
        <<",\"watchdogFeeds\":"<<watchdogFeeds<<",\"touchReads\":"<<touchReads<<",\"socketAttempts\":"<<socketAttempts
        <<",\"workersStarted\":"<<RicIoWorker::startCount()<<",\"ttlSeconds\":"<<lastTtl
        <<",\"journalValid\":"<<(journal==CheckoutJournal::LoadResult::Valid?"true":"false")
        <<",\"journalReference\":"<<quote(record.reference)
        <<",\"maintenance\":{\"ota\":"<<otaChecks<<",\"hello\":"<<helloCalls<<",\"price\":"<<priceCalls<<",\"nfcReinit\":"<<nfcReinits<<'}'
        <<",\"calls\":[";
    for(size_t i=0;i<calls.size();++i){const auto& c=calls[i];if(i)std::cout<<',';
        std::cout<<"{\"name\":"<<quote(c.name)<<",\"key\":"<<quote(c.key)<<",\"payload\":"<<quote(c.payload)
            <<",\"worker\":"<<quote(c.worker)<<",\"at\":"<<c.at<<",\"uiWrites\":"<<c.uiWrites
            <<",\"journalValid\":"<<(c.journalValid?"true":"false")<<",\"journalDispatched\":"<<(c.dispatched?"true":"false")
            <<",\"journalReference\":"<<quote(c.journalReference)<<'}';}
    std::cout<<"]}\n";
}
}

int main(int argc,char** argv){
    using namespace test;
    const std::string scenario=argc>1?argv[1]:"frozen-tls";
    try{
        if(scenario=="transport-deny-canary"){
            sockaddr target{};addrinfo* resolved=nullptr;
            require(::socket(AF_INET,SOCK_STREAM,0)==-1 && errno==EACCES,"socket transport deny wrapper missing");
            require(::connect(-1,&target,sizeof(target))==-1 && errno==EACCES,"connect deny wrapper missing");
            require(::sendto(-1,"x",1,0,&target,sizeof(target))==-1 && errno==EACCES,"sendto deny wrapper missing");
            require(::getaddrinfo("no-payment.invalid",nullptr,nullptr,&resolved)==EAI_FAIL,"DNS deny wrapper missing");
            require(socketAttempts==4,"transport canary did not exercise all deny wrappers");
            report(scenario,true,"");return 0;
        }
        if(scenario=="frozen-tls")frozenTls();
        else if(scenario=="frozen-nfc")frozenNfc();
        else if(scenario=="callback-paid-only")callbackPaidOnly();
        else if(scenario=="callback-timeout-once")callbackTimeoutOnce();
        else if(scenario=="wifi-preserve-hash")wifiPreservesHash();
        else if(scenario=="boot-receive-unsent")bootQueryOnly(false,false);
        else if(scenario=="boot-receive-dispatched")bootQueryOnly(false,true);
        else if(scenario=="boot-withdraw-unsent")bootQueryOnly(true,false);
        else if(scenario=="boot-withdraw-dispatched")bootQueryOnly(true,true);
        else if(scenario=="receive-window-600")receiveWindow();
        else if(scenario=="receive-expiry-qr")receiveExpiry(false);
        else if(scenario=="receive-expiry-card")receiveExpiry(true);
        else if(scenario=="typed-pin-retry")typedPinRetry();
        else if(scenario=="send-shared-k1")sendSharedK1();
        else if(scenario=="journal-before-expose")journalBeforeExpose();
        else if(scenario=="maintenance-gate")maintenanceGate();
        else if(scenario=="pin-timeout-not-rejection")pinTimeoutIsNotRejection();
        else if(scenario=="cancel-while-detecting")cancelWhileDetecting();
        else if(scenario=="boot-corrupt-journal")bootJournalFault(false);
        else if(scenario=="boot-unavailable-journal")bootJournalFault(true);
        else if(scenario=="invoice-journal-save-failure")invoiceJournalSaveFailure();
        else if(scenario=="worker-network-unavailable")workerAllocationFailure(false);
        else if(scenario=="worker-nfc-unavailable")workerAllocationFailure(true);
        else if(scenario=="cancel-retry-after-pending")cancelRetryAfterPending();
        else if(scenario=="send-timeout-once")sendTimeoutOnce();
        else throw std::runtime_error("unknown scenario: "+scenario);
        require(socketAttempts==0,"unexpected attempt to use a real network transport");
        report(scenario,true,"");return 0;
    }catch(const std::exception& error){report(scenario,false,error.what());return 1;}
}
