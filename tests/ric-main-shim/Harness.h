#pragma once
// Explicit test doubles for hardware/screens/API. The checkout code is never
// reproduced here: ric-main.cpp includes a byte-identical actual main.cpp.
#include "Arduino.h"
#include "TFT_eSPI.h"
#include "WiFi.h"
#include "SPI.h"
#include "XPT2046_Touchscreen.h"
#include "esp_task_wdt.h"
#include "core/RicIoWorker.h"
#include "core/RicPolicy.h"
#include "core/CheckoutJournal.h"
#include "core/CheckoutPolicy.h"
#include "core/Version.h"
#include "ui/Theme.h"
#include RIC_API_HEADER
#include <deque>
#include <functional>
#include <iostream>
#include <utility>
#include <cerrno>
#include <sys/socket.h>
#include <netdb.h>

namespace RicMainShim {
inline const String paymentHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
inline const String withdrawK1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
inline const String cardK1 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
inline const String bolt11 = "lnbc_test_fixture_not_a_valid_invoice_NO_PAYMENT";
inline const String withdrawQr = "LNURL_TEST_FIXTURE_NO_PAYMENT";
struct Call {
    std::string name, key, payload, pin, worker, journalReference;
    uint32_t at=0;
    unsigned uiWrites=0;
    bool journalValid=false, dispatched=false;
};
inline std::vector<Call> calls;
inline void io(const char* name,const String& key="",const String& payload="",const String& pin="") {
    CheckoutJournal::Record record{};
    auto loaded=CheckoutJournal::load(record);
    calls.push_back({name,key.c_str(),payload.c_str(),pin.c_str(),worker,record.reference,
        millis(),displayWrites,loaded==CheckoutJournal::LoadResult::Valid,record.dispatched});
    if(strictIo && worker.empty()) throw std::runtime_error(std::string("blocking IO executed on UI loop: ")+name);
}
inline size_t count(const std::string& name) {return std::count_if(calls.begin(),calls.end(),[&](const Call& c){return c.name==name;});}
inline const Call& last(const std::string& name) {for(auto i=calls.rbegin();i!=calls.rend();++i)if(i->name==name)return *i;throw std::runtime_error("No call: "+name);}
inline String pop(std::deque<String>& queue,const String& fallback) {if(queue.empty())return fallback;auto v=queue.front();queue.pop_front();return v;}
inline std::deque<String> invoiceStatuses,withdrawStatuses,callbackErrors;
inline String invoiceStatus="pending",withdrawStatus="pending",callbackError="";
inline String createError="",withdrawError="",sendError="",lnurlError="";
inline String callbackKind="accepted", cancelKind="pending", sendKind="pending";
inline uint32_t invoiceTtl=600;
inline std::deque<String> lnurlK1s;
inline std::deque<String> callbackKinds,cancelKinds;
inline long pinLimitMsats=-1;
inline unsigned lnurlFetches=0;
inline std::deque<std::pair<String,String>> cards;
inline String lastCardUrl;
inline unsigned paymentDraws=0,paymentUpdates=0,pinUpdates=0,processingUpdates=0,wrongPins=0;
inline unsigned idleDraws=0,successDraws=0,errorDraws=0,otaChecks=0,helloCalls=0,priceCalls=0,nfcReinits=0;
inline unsigned journalWritesAtQr=0;
inline String lastQr,stageLabel,lastResult,pinValue="1234";
inline int lastTtl=0;
inline uint32_t qrDrawAt=0;
inline bool paymentCanCancel=true,sendMode=false,hasAmountInput=false;
inline bool paymentCancel=false,resultDismiss=false,resultAutoDismiss=false,payTouch=false;
inline char pinAction=0;
inline long amount=123;
inline void display(){ui();}
inline void card(const String& suffix="first") {cards.emplace_back("04aabbcc",String("https://cards.invalid/card/")+suffix+"?p=fixture&c=fixture");}
}

class Config {
public:
    inline static String ssid="RIC-HOST-TEST",pass="not-a-password",token="NO_REAL_TOKEN",serverUrl="https://ric-test.invalid/api",currency="sats";
    inline static bool provisioned=true;
    static bool isProvisioned(){return provisioned;}
    static void save(const String&,const String&,const String&,const String&,const String&){}
    static void saveWifi(const String&,const String&){}
    static void clear(){provisioned=false;}
    static void load(){}
};
class ProvisionService {
public:
    inline static String ssid,pass,token,serverUrl,currency;
    inline static bool active=false;
    static void begin(){active=true;}
    static void stop(){active=false;}
    static void setStatus(const String&){}
    static bool isActive(){return active;}
    static bool isComplete(){return false;}
};
class ProvisionScreen {public: static void draw(TFT_eSPI&){RicMainShim::display();} static void update(TFT_eSPI&){RicMainShim::display();}};
class AmountScreen {
public:
    static void draw(TFT_eSPI&){RicMainShim::display();++RicMainShim::idleDraws;}
    static bool handleTouch(TFT_eSPI&,int,int){return std::exchange(RicMainShim::payTouch,false);}
    static long getAmountSats(){return RicMainShim::amount;}
    static bool hasInput(){return RicMainShim::hasAmountInput;}
    static void setPrice(float,const String&){}
    static void setStatus(bool,bool){}
    static void updateAmountDisplay(TFT_eSPI&){RicMainShim::display();}
    static void updateHeader(TFT_eSPI&){RicMainShim::display();}
    static String fiatLabel(){return "123 sats";}
    static bool isSettingsTap(int,int){return false;}
    static bool isSendMode(){return RicMainShim::sendMode;}
    static void setSendMode(bool value){RicMainShim::sendMode=value;}
    static void setSendSatsPerUnit(float){}
    static bool isPayButtonHeld(int,int){return false;}
    static void startPayHold(int,int){}
    static bool checkPayHold(uint32_t){return false;}
    static void cancelPayHold(){}
    static bool isPayHoldActive(){return false;}
};
class PaymentScreen {
public:
    static void draw(TFT_eSPI&,const String& qr,long,const String&,int ttl){
        RicMainShim::display();++RicMainShim::paymentDraws;
        RicMainShim::lastQr=qr;RicMainShim::lastTtl=ttl;RicMainShim::qrDrawAt=millis();
        RicMainShim::journalWritesAtQr=FakeNvs::state().puts;RicMainShim::paymentCanCancel=true;
    }
    static void update(TFT_eSPI&){RicMainShim::display();++RicMainShim::paymentUpdates;}
    static void showCardDetected(TFT_eSPI&){RicMainShim::display();}
    static void setStage(TFT_eSPI&,const String& label,bool cancel=true){RicMainShim::display();RicMainShim::stageLabel=label;RicMainShim::paymentCanCancel=cancel;}
    static bool handleTouch(int,int){return RicMainShim::paymentCanCancel && std::exchange(RicMainShim::paymentCancel,false);}
    static int remainingSec(uint32_t now){const uint32_t elapsed=now-RicMainShim::qrDrawAt;return elapsed>=uint32_t(RicMainShim::lastTtl)*1000?0:(uint32_t(RicMainShim::lastTtl)*1000-elapsed+999)/1000;}
};
class PinScreen {
public:
    static void draw(TFT_eSPI&,const String&,int=4){RicMainShim::display();}
    static void update(TFT_eSPI&){RicMainShim::display();++RicMainShim::pinUpdates;}
    static char handleTouch(TFT_eSPI&,int,int){return std::exchange(RicMainShim::pinAction,char(0));}
    static String getPin(){return RicMainShim::pinValue;}
    static void clearPin(){RicMainShim::pinValue="";}
    static void setWrongPin(TFT_eSPI&){RicMainShim::display();++RicMainShim::wrongPins;}
    static void drawProcessing(TFT_eSPI&,const char* = "Verifying",const char* = "PIN..."){RicMainShim::display();++RicMainShim::processingUpdates;}
    static void drawConfirming(TFT_eSPI&){RicMainShim::display();++RicMainShim::processingUpdates;}
    static void updateConfirming(TFT_eSPI&){RicMainShim::display();++RicMainShim::processingUpdates;}
};
enum ResultType {RESULT_SUCCESS,RESULT_ERROR};
class ResultScreen {
public:
    static void draw(TFT_eSPI&,ResultType type,long=0,const String& message="",bool=false,const String& = "Payment failed",const String& = ""){
        RicMainShim::display();RicMainShim::lastResult=message;
        if(type==RESULT_SUCCESS)++RicMainShim::successDraws;else ++RicMainShim::errorDraws;
    }
    static bool handleTouch(int,int){return std::exchange(RicMainShim::resultDismiss,false);}
    static bool shouldAutoDismiss(){return RicMainShim::resultAutoDismiss;}
};
class WifiSetupScreen {
public:
    static void enter(TFT_eSPI&){}
    static String update(TFT_eSPI&){return "";}
    static String getSelectedSsid(){return "RIC-HOST-TEST";}
    static String getSelectedPassword(){return "not-a-password";}
    static String handleTouch(TFT_eSPI&,int,int){return "";}
};
constexpr int SETTINGS_UPDATES=5;
class SettingsMenu {public: static void draw(TFT_eSPI&){RicMainShim::display();} static int handleTouch(int,int){return -1;}};
class Buzzer {
public:
    static void init(){} static void playBoot(){} static void playSuccess(){} static void playError(){} static void playTap(){}
    static void startBeep(){} static void stopBeep(){}
};
class NfcReader {
public:
    static bool begin(){return true;}
    static bool reinit(){++RicMainShim::nfcReinits;RicMainShim::io("nfcReinit");return true;}
    static bool detectCard(String& uid){
        RicMainShim::io("detectCard");if(RicMainShim::cards.empty())return false;
        auto card=RicMainShim::cards.front();RicMainShim::cards.pop_front();uid=card.first;RicMainShim::lastCardUrl=card.second;return true;
    }
    static String readNdef(){RicMainShim::io("readNdef");return RicMainShim::lastCardUrl;}
};
inline String NfcWriter::writeCard(const ProvisionData&,void(*)(const char*,bool)){throw std::runtime_error("OUT OF SCOPE: physical card write attempted");}
inline String NfcWriter::wipeCard(const WipeData&,void(*)(const char*,bool)){throw std::runtime_error("OUT OF SCOPE: physical card wipe attempted");}
class DeviceLink {
public:
    static RicPolicy::AuthState hello(){++RicMainShim::helloCalls;return RicPolicy::AuthState::Accepted;}
    static void release(){}
};
class OTAManager {
public:
    static String lastStatus(){return "host fixture: no OTA";}
    static String lastCode(){return "host_fixture";}
    static void display(TFT_eSPI&,const String&,const String&){RicMainShim::display();}
    static void bootConfirmed(){}
    static bool checkAndUpdate(TFT_eSPI&,bool=false){++RicMainShim::otaChecks;return false;}
};

// Real public BitposClient declarations + explicit scripted definitions. We do
// NOT link BitposClient.cpp, TLS, HTTP, wallet code, or any payment transport.
inline void BitposClient::init(const String&,const String&){}
inline Invoice BitposClient::createInvoice(long amount,String& err){
    RicMainShim::io("createInvoice");err=RicMainShim::createError;
    const bool first=RicMainShim::count("createInvoice")==1;
    Invoice invoice{first?RicMainShim::bolt11:RicMainShim::bolt11+String(RicMainShim::count("createInvoice")),
        first?RicMainShim::paymentHash:String("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
        amount,"2099-01-01T00:00:00Z"};
#ifdef RIC_MAIN_TYPED_API
    invoice.ttlSec=RicMainShim::invoiceTtl;
#endif
    return invoice;
}
inline String BitposClient::pollInvoiceStatus(const String& hash){RicMainShim::io("pollInvoiceStatus",hash);return RicMainShim::pop(RicMainShim::invoiceStatuses,RicMainShim::invoiceStatus);}
inline float BitposClient::fetchPrice(const String&){++RicMainShim::priceCalls;return 1;}
inline String BitposClient::fetchCurrency(String& receive,String& send){receive="";send="";return "sats";}
inline bool BitposClient::healthCheck(){return true;}
inline void BitposClient::releaseConnections(){}
inline BitposClient::LnurlWithdraw BitposClient::fetchLnurl(const String& url,String& err){
    RicMainShim::io("fetchLnurl",url);++RicMainShim::lnurlFetches;err=RicMainShim::lnurlError;
    return {"withdrawRequest","https://cards.invalid/callback?existing=1",RicMainShim::pop(RicMainShim::lnurlK1s,RicMainShim::cardK1),100000000,"host fixture",RicMainShim::pinLimitMsats};
}
inline String BitposClient::callLnurlCallback(const String& url,const String& k1,const String& invoice,const String& pin){
    RicMainShim::io("callback",k1,invoice,pin);(void)url;
    return RicMainShim::pop(RicMainShim::callbackErrors,RicMainShim::callbackError);
}
inline String BitposClient::createWithdraw(long,const String& pin,String& err,String& k1
#ifdef RIC_MAIN_WITHDRAW_REQUEST_ID
    ,const String& requestId
#endif
){
    RicMainShim::io("createWithdraw","","",pin);err=RicMainShim::withdrawError;k1=RicMainShim::withdrawK1;
#ifdef RIC_MAIN_WITHDRAW_REQUEST_ID
    if(!requestId.isEmpty())k1=requestId;
#endif
    return RicMainShim::withdrawQr;
}
#ifdef RIC_MAIN_TYPED_API
namespace RicMainShim {
inline CardTransportPolicy::Outcome outcome(const String& kind){
    using O=CardTransportPolicy::Outcome;
    if(kind=="accepted" || kind=="unknown" || kind=="pending")return O::Pending;
    if(kind=="wrong_pin")return O::PinRejected;
    if(kind=="not_submitted")return O::NotSubmitted;
    if(kind=="rejected")return O::Rejected;
    if(kind=="paid")return O::Paid;
    if(kind=="failed")return O::Failed;
    if(kind=="expired")return O::Expired;
    if(kind=="cancelled")return O::Cancelled;
    throw std::runtime_error(std::string("Unscripted fixture outcome: ")+kind.c_str());
}
}
inline CardTransportPolicy::Outcome BitposClient::submitLnurlCallback(const String& url,const String& k1,const String& invoice,const String& pin,String& detail){
    RicMainShim::io("callback",k1,invoice,pin);(void)url;
    detail=RicMainShim::pop(RicMainShim::callbackErrors,RicMainShim::callbackError);
    return RicMainShim::outcome(RicMainShim::pop(RicMainShim::callbackKinds,RicMainShim::callbackKind));
}
inline CardTransportPolicy::Outcome BitposClient::submitCardSend(const String& url,long,const String& pin,const String& k1,String& detail){
    RicMainShim::io("sendToCard",k1,url,pin);detail=RicMainShim::sendError;
    return RicMainShim::outcome(RicMainShim::sendKind);
}
inline CardTransportPolicy::Outcome BitposClient::cancelWithdraw(const String& k1,String& detail){
    RicMainShim::io("cancelWithdraw",k1);detail="fixture cancellation response";
    return RicMainShim::outcome(RicMainShim::pop(RicMainShim::cancelKinds,RicMainShim::cancelKind));
}
inline CardTransportPolicy::Outcome BitposClient::cancelInvoice(const String& hash,String& detail){
    RicMainShim::io("cancelInvoice",hash);detail="fixture cancellation response";
    return RicMainShim::outcome(RicMainShim::pop(RicMainShim::cancelKinds,RicMainShim::cancelKind));
}
#endif
inline String BitposClient::pollWithdrawStatus(const String& k1){RicMainShim::io("pollWithdrawStatus",k1);return RicMainShim::pop(RicMainShim::withdrawStatuses,RicMainShim::withdrawStatus);}
inline String BitposClient::sendToCard(const String& url,long,const String& pin,String& err){RicMainShim::io("sendToCard","",url,pin);err=RicMainShim::sendError;return "";}
inline bool BitposClient::fetchNextProvision(ProvisionData&,String&){throw std::runtime_error("OUT OF SCOPE: card provisioning attempted");}
inline bool BitposClient::markCardWritten(const String&,String&){throw std::runtime_error("OUT OF SCOPE: card provisioning attempted");}
inline bool BitposClient::fetchWipeKeys(const String&,WipeData&,String&){throw std::runtime_error("OUT OF SCOPE: card wipe attempted");}
inline bool BitposClient::markCardWiped(const String&,String&){throw std::runtime_error("OUT OF SCOPE: card wipe attempted");}

// Link-time transport deny-list is defense in depth. No socket is opened even
// if a new test accidentally introduces a conventional network dependency.
extern "C" int __wrap_socket(int,int,int){++RicMainShim::socketAttempts;errno=EACCES;return -1;}
extern "C" int __wrap_connect(int,const sockaddr*,socklen_t){++RicMainShim::socketAttempts;errno=EACCES;return -1;}
extern "C" ssize_t __wrap_sendto(int,const void*,size_t,int,const sockaddr*,socklen_t){++RicMainShim::socketAttempts;errno=EACCES;return -1;}
extern "C" int __wrap_getaddrinfo(const char*,const char*,const addrinfo*,addrinfo**){++RicMainShim::socketAttempts;return EAI_FAIL;}
