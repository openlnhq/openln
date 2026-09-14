#include "api/BitposClient.h"
#include <cassert>
#include <iostream>
#include <functional>
using namespace RicTransportShim;
const String KEY(std::string(64,'a'));
const String HASH(std::string(64,'b'));
const String CARD("https://openln.com/api/cards/tap/card?p=0102&c=abcd");
const String CALLBACK("https://openln.com/api/cards/callback");
std::string metadata(const std::string& callback="https://openln.com/api/cards/callback") {
    return "{\"tag\":\"withdrawRequest\",\"callback\":\""+callback+"\",\"k1\":\"challenge\",\"maxWithdrawable\":5000000000,\"defaultDescription\":\"Card\"}";
}
void fresh() {BitposClient::releaseConnections();reset();BitposClient::init("https://openln.com/api","device-test-token");}
void sameOriginReuse() {
    fresh();String receive,send,err;
    queue("{\"currency\":\"thb\",\"rateModifier\":\"THB*1.01\",\"sendRateModifier\":\"THB*0.99\"}");
    assert(BitposClient::fetchCurrency(receive,send)=="thb");
    queue(metadata());assert(BitposClient::fetchLnurl(CARD,err).tag=="withdrawRequest");assert(err.isEmpty());
    queue("{\"status\":\"paid\",\"paymentHash\":\""+std::string(HASH.c_str())+"\"}");
    assert(BitposClient::pollInvoiceStatus(HASH)=="paid");
    assert(requests.size()==3);
    assert(handshakes==1 && "same-origin public card metadata must not discard authenticated TLS");
    assert(maxLive==1);
    assert(requests[0].headers.at("Authorization")=="Bearer device-test-token");
    assert(requests[1].headers.count("Authorization")==0);
    assert(requests[2].headers.at("Authorization")=="Bearer device-test-token");
}
void securePublicTransport() {
    fresh();assert(insecureCalls==0 && "public card transport must authenticate TLS");
    String a,b,err;queue("{\"currency\":\"thb\"}");BitposClient::fetchCurrency(a,b);
    queue(metadata("https://bitpos.app/api/cards/callback"));
    assert(BitposClient::fetchLnurl("https://bitpos.app/api/cards/tap/card?p=ab&c=cd",err).tag=="withdrawRequest");
    queue("{\"status\":\"paid\",\"paymentHash\":\""+std::string(HASH.c_str())+"\"}");
    assert(BitposClient::pollInvoiceStatus(HASH)=="paid");
    assert(maxLive==1 && handshakes==3);
    assert(requests[1].url=="https://bitpos.app/api/cards/tap/card?p=ab&c=cd");
    for(const auto& r:requests){assert(r.trusted);assert(r.connectTimeout==10000);assert(r.tlsTimeout==10);assert(r.bodyTimeout==8000);assert(r.redirects==0);}
    assert(requests[1].headers.count("Authorization")==0);
    fresh();Response bad;bad.body=metadata();bad.tlsValid=false;responses.push_back(bad);
    BitposClient::fetchLnurl("https://bitpos.app/api/cards/tap/card",err);
    assert(!err.isEmpty());assert(requests.empty());assert(getCalls==1);assert(insecureCalls==0);
    for(const String& badUrl:{String("http://openln.com/api/cards/x"),String("https://user:secret@openln.com/api/cards/x"),String("https://openln.com/api/cards/x#fragment"),String("https://openln.com/api/cards/x\r\nAuthorization: evil"),String("https://openln.com:65536/x"),String("https://openln.com:/x"),String("https://openln.com%2Fevil/x"),String("https://openln.com\\@evil/x"),String("https:///x"),String("https://openln.com/x%q0"),String("https://openln.com/x")+String(std::string(5000,'a')),String("https://openln.com/x\0truncated",29)}) {
        fresh();err="";BitposClient::fetchLnurl(badUrl,err);assert(!err.isEmpty());assert(getCalls==0 && "invalid URL must be rejected before HTTP");
    }
}
std::string chunk(const std::string& data) {char n[32];std::snprintf(n,sizeof(n),"%zx",data.size());return std::string(n)+"\r\n"+data+"\r\n";}
void boundedCompleteBodies() {
    fresh();String err;std::string atLimit=metadata();atLimit+=std::string(4096-atLimit.size(),' ');
    queue(atLimit);assert(BitposClient::fetchLnurl(CARD,err).tag=="withdrawRequest");assert(err.isEmpty());
    assert(getStringCalls==0 && "HTTPClient::getString creates an uncapped temporary");
    for(bool chunked:{false,true}) {
        fresh();Response r;r.body=atLimit;r.length=chunked?-1:-2;r.transferEncoding=chunked?"chunked":"";if(chunked)r.raw=chunk(atLimit)+"0\r\nTrace: bounded\r\n\r\n";responses.push_back(r);
        assert(BitposClient::fetchLnurl(CARD,err).tag=="withdrawRequest");assert(err.isEmpty());assert(live==1);
        fresh();r.body=atLimit+" ";if(chunked)r.raw=chunk(r.body)+"0\r\n\r\n";responses.push_back(r);
        assert(BitposClient::fetchLnurl(CARD,err).tag.isEmpty());assert(!err.isEmpty());assert(live==0);
    }
    for(bool keepAlive:{false,true}) {
        fresh();Response r;r.body=metadata();r.length=int(r.body.size()+10);r.keepAlive=keepAlive;responses.push_back(r);
        BitposClient::fetchLnurl(CARD,err);assert(!err.isEmpty());assert(live==0);assert(now<=9000);
    }
    for(const auto& raw:std::vector<std::string>{chunk(metadata()),chunk(metadata())+"0\r\n",chunk(metadata())+"0\r\nTrailer: x\r\n",chunk(metadata())+"0\r\n"+std::string(600,'x')+"\r\n\r\n","garbage\r\n"+metadata(),"10000000000000000\r\n","1\r\n{XX0\r\n\r\n",chunk(metadata())+"0\r\n\rX"}) {
        fresh();Response r;r.body=metadata();r.length=-1;r.transferEncoding="chunked";r.raw=raw;responses.push_back(r);
        BitposClient::fetchLnurl(CARD,err);assert(!err.isEmpty());assert(live==0);assert(now<=9000);
    }
    fresh();Response slow;slow.body=metadata();slow.byteDelay=100;responses.push_back(slow);BitposClient::fetchLnurl(CARD,err);assert(!err.isEmpty());assert(now<=9000 && "absolute body deadline, not a reset-on-each-byte timeout");
    fresh();now=UINT32_MAX-100;responses.push_back(slow);uint32_t start=now;BitposClient::fetchLnurl(CARD,err);assert(!err.isEmpty());assert(uint32_t(now-start)<=8000);
    fresh();Response close;close.body=metadata();close.length=-1;close.keepAlive=false;responses.push_back(close);assert(BitposClient::fetchLnurl(CARD,err).tag=="withdrawRequest");assert(err.isEmpty());assert(live==0);
    fresh();Response conflicting;conflicting.body=metadata();conflicting.transferEncoding="chunked";conflicting.raw=chunk(conflicting.body)+"0\r\n\r\n";responses.push_back(conflicting);BitposClient::fetchLnurl(CARD,err);assert(!err.isEmpty());assert(live==0);
}
// Locally signed offline 100-sat fixture. No wallet or network is used by this suite.
const String BOLT11("lnbc1000n1p420zl8pp5lmazxv0dm7ldlns0g20j352v062lv2m8u9a6f5g7m7vq7drhxp0qdpyfanxvmrfdejjq5jfgvs9zsfqd9h8vmmfvdjsnp4qfumuen7l8wthtz45p3ftn58pvrs9xlumvkuu2xet8egzkcklqtesc53wtfypkdrk2vwll6c7z5t4qql7ch8xf7vqd4th29dha9qr3pz3p45zf45mlwnv43y9y6sur8nzzuzc0dtumzn85wfnv9e6m4w8j0cq7v6jdn");
const String INVOICE_HASH("fefa2331eddfbedfce0f429f28d14c7e95f62b67e17ba4d11edf980f3477305e");
using Outcome=CardTransportPolicy::Outcome;
void callbackOutcomes() {
    struct Case{int code;std::string body;Outcome outcome;};
    const Case cases[]={
        {200,"{\"status\":\"OK\"}",Outcome::Pending},
        {202,"{\"status\":\"pending\",\"doNotRetry\":true}",Outcome::Pending},
        {-11,"",Outcome::Pending},{-5,"",Outcome::Pending},{-2,"",Outcome::Pending},
        {500,"{\"status\":\"ERROR\",\"code\":\"PIN_INVALID\",\"dispatched\":false}",Outcome::Pending},
        {200,"{\"status\":\"ERROR\",\"reason\":\"Incorrect PIN, wrong\"}",Outcome::Pending},
        {200,"{\"status\":\"ERROR\",\"code\":\"PIN_INVALID\",\"dispatched\":false,\"reason\":\"Incorrect card PIN\"}",Outcome::PinRejected},
        {200,"{\"status\":\"ERROR\",\"code\":\"PIN_REQUIRED\",\"dispatched\":false}",Outcome::PinRejected},
        {200,"{\"status\":\"ERROR\",\"code\":\"CARD_PIN_LOCKED\",\"dispatched\":false}",Outcome::Rejected},
        {200,"{\"status\":\"ERROR\",\"code\":\"PIN_INVALID\",\"dispatched\":\"false\"}",Outcome::Pending},
        {200,"{\"status\":\"ERROR\",\"code\":\"PIN_INVALID\",\"dispatched\":true}",Outcome::Pending},
        {200,"{\"status\":\"ERROR\",\"code\":\"PIN_INVALID\",\"dispatched\":false,\"doNotRetry\":true}",Outcome::Pending},
        {200,"{\"status\":\"ERROR\",\"code\":\"PIN_INVALID\",\"dispatched\":false,\"k1\":\"wrong-key\"}",Outcome::Pending},
        {200,"{\"status\":\"ERROR\",\"code\":\"PIN_INVALID\",\"dispatched\":false}trailing",Outcome::Pending},
        {200,"{\"status\":\"ERROR\",\"code\":\"PIN_INVALID\",\"dispatched\":false",Outcome::Pending},
        {200,"{\"status\":\"paid\",\"paymentStatus\":\"paid\"}",Outcome::Pending},
        {200,"{\"status\":true}",Outcome::Pending},{200,"[]",Outcome::Pending},
        {302,"{\"status\":\"OK\"}",Outcome::Pending}
    };
    for(const auto& c:cases){fresh();queue(c.body,c.code);String detail;assert(BitposClient::submitLnurlCallback(CALLBACK,"challenge",BOLT11,"1234",detail)==c.outcome);assert(getCalls==1);assert(postCalls==0);assert(!detail.isEmpty());assert(requests[0].headers.count("Authorization")==0);}
    fresh();queue("{\"status\":\"OK\"}");String detail;
    assert(BitposClient::submitLnurlCallback(CALLBACK+"?token=x%26y","opaque +&?/=%",BOLT11,"1234",detail)==Outcome::Pending);
    assert(requests[0].url.find("?token=x%26y&k1=opaque%20%2B%26%3F%2F%3D%25&pr=")!=std::string::npos);
    assert(requests[0].url.find("&pin=1234")!=std::string::npos);
    fresh();Response shortBody;shortBody.body=cases[6].body;shortBody.length=int(shortBody.body.size()+1);shortBody.keepAlive=false;responses.push_back(shortBody);
    assert(BitposClient::submitLnurlCallback(CALLBACK,"challenge",BOLT11,"1234",detail)==Outcome::Pending);
    fresh();queue(cases[6].body+std::string(4097,' '));assert(BitposClient::submitLnurlCallback(CALLBACK,"challenge",BOLT11,"1234",detail)==Outcome::Pending);assert(getCalls==1);
    fresh();queue(cases[6].body);assert(BitposClient::submitLnurlCallback("https://third-party.example/callback","challenge",BOLT11,"1234",detail)==Outcome::Pending);
    fresh();beginOk=false;assert(BitposClient::submitLnurlCallback(CALLBACK,"challenge",BOLT11,"1234",detail)==Outcome::NotSubmitted);assert(getCalls==0);
    for(const String& badCallback:{CALLBACK+"?k1=old",CALLBACK+"?%70r=old",CALLBACK+"?pin=old",String("http://openln.com/callback"),CALLBACK+String(std::string(CardTransportPolicy::MaxUrlChars-CALLBACK.length(),'x'))}){
        fresh();assert(BitposClient::submitLnurlCallback(badCallback,"challenge",BOLT11,"1234",detail)==Outcome::NotSubmitted);assert(getCalls==0);
    }
    for(const String& badInvoice:{String(),String("not-an-invoice"),BOLT11+"&pin=0000"}){
        fresh();assert(BitposClient::submitLnurlCallback(CALLBACK,"challenge",badInvoice,"1234",detail)==Outcome::NotSubmitted);assert(getCalls==0);
    }
    fresh();assert(BitposClient::submitLnurlCallback(CALLBACK,"",BOLT11,"1234",detail)==Outcome::NotSubmitted);assert(getCalls==0);
    fresh();assert(BitposClient::submitLnurlCallback(CALLBACK,"challenge",BOLT11,"123456",detail)==Outcome::NotSubmitted);assert(getCalls==0);
    fresh();String a,b,err;queue("{\"currency\":\"thb\"}");BitposClient::fetchCurrency(a,b);queue(metadata());BitposClient::fetchLnurl(CARD,err);queue("{\"status\":\"OK\"}");assert(BitposClient::submitLnurlCallback(CALLBACK,"challenge",BOLT11,"",detail)==Outcome::Pending);queue("{\"status\":\"paid\",\"paymentHash\":\""+std::string(HASH.c_str())+"\"}");assert(BitposClient::pollInvoiceStatus(HASH)=="paid");assert(handshakes==1);assert(requests[2].headers.count("Authorization")==0);assert(requests[2].headers.count("Content-Type")==0);assert(requests[3].headers.at("Authorization")=="Bearer device-test-token");
}
std::string sendReply(const std::string& fields,const String& key=KEY) {return "{\"k1\":\""+std::string(key.c_str())+"\","+fields+"}";}
void sendOutcomes() {
    const std::string paid=sendReply("\"status\":\"OK\",\"paymentStatus\":\"paid\",\"paymentHash\":\""+std::string(HASH.c_str())+"\"");
    fresh();queue(paid);String detail;assert(BitposClient::submitCardSend(CARD,100,"123456",KEY,detail)==Outcome::Paid);assert(postCalls==1 && getCalls==0);
    JsonDocument sent;assert(!deserializeJson(sent,requests[0].body));assert(sent.size()==4);assert(sent["cardUrl"]==CARD);assert(sent["k1"]==KEY);assert(sent["amountSats"].is<long>() && sent["amountSats"].as<long>()==100);assert(sent["pin"]=="123456");
    assert(requests[0].url=="https://openln.com/api/pos/send-to-card");assert(requests[0].headers.at("Content-Type")=="application/json");assert(requests[0].headers.at("Authorization")=="Bearer device-test-token");
    for(const auto& c:std::vector<std::pair<int,std::string>>{{202,sendReply("\"status\":\"pending\",\"doNotRetry\":true")},{500,paid},{-11,""},{-3,""},{409,paid},{200,sendReply("\"status\":\"OK\"")},{200,sendReply("\"status\":\"OK\",\"paymentStatus\":\"paid\"",HASH)},{200,sendReply("\"status\":\"OK\",\"paymentStatus\":\"paid\",\"paymentHash\":\"bad\"")},{200,sendReply("\"status\":\"OK\",\"paymentStatus\":\"paid\",\"paymentHash\":null")},{200,paid+"junk"},{200,"{\"status\":\"OK\",\"paymentStatus\":\"paid\"}"},{401,"{\"error\":\"Authentication required\"}"}}) {
        fresh();queue(c.second,c.first);assert(BitposClient::submitCardSend(CARD,100,"123456",KEY,detail)==Outcome::Pending);assert(postCalls==1 && getCalls==0);assert(!detail.isEmpty());
    }
    fresh();queue(sendReply("\"status\":\"OK\",\"paymentStatus\":\"paid\""));assert(BitposClient::submitCardSend(CARD,100,"123456",KEY,detail)==Outcome::Paid);
    fresh();queue(sendReply("\"error\":\"Invalid card URL\",\"code\":\"INVALID_REQUEST\""),400);assert(BitposClient::submitCardSend(CARD,100,"123456",KEY,detail)==Outcome::Rejected);
    for(const String& key:{String(),String(std::string(63,'a')),String(std::string(64,'A')),String(std::string(64,'g')),KEY+"/status"}){fresh();assert(BitposClient::submitCardSend(CARD,100,"123456",key,detail)==Outcome::NotSubmitted);assert(postCalls==0);}
    for(const long amount:{0L,-1L,2147483648L}){fresh();assert(BitposClient::submitCardSend(CARD,amount,"123456",KEY,detail)==Outcome::NotSubmitted);assert(postCalls==0);}
    for(const String& pin:{String(),String("123"),String("1234567"),String("12\"456")}){fresh();assert(BitposClient::submitCardSend(CARD,100,pin,KEY,detail)==Outcome::NotSubmitted);assert(postCalls==0);}
    for(const String& pin:{String("1234"),String("12345"),String("123456")}){fresh();queue(paid);assert(BitposClient::submitCardSend(CARD,100,pin,KEY,detail)==Outcome::Paid);}
    fresh();String err;assert(BitposClient::sendToCard(CARD,100,"123456",err)=="Update RIC firmware before sending to a card. Use QR sending on this version.");assert(err=="Update RIC firmware before sending to a card. Use QR sending on this version.");assert(postCalls==0);
    fresh();queue(paid);assert(BitposClient::submitCardSend(CARD,100,"123456",KEY,detail)==Outcome::Paid);queue(metadata());BitposClient::fetchLnurl(CARD,err);queue("{\"status\":\"paid\",\"paymentHash\":\""+std::string(HASH.c_str())+"\"}");assert(BitposClient::pollInvoiceStatus(HASH)=="paid");assert(handshakes==1);assert(requests[1].headers.count("Authorization")==0);assert(requests[1].headers.count("Content-Type")==0);assert(requests[1].headers.count("Content-Length")==0);assert(requests[2].headers.count("Content-Type")==0);assert(requests[2].headers.count("Content-Length")==0);
}
void cancellationOutcomes() {
    for(bool invoice:{false,true}) {
        const char* keyField=invoice?"paymentHash":"k1";
        auto response=[&](const std::string& fields,const String& key){return "{\""+std::string(keyField)+"\":\""+std::string(key.c_str())+"\","+fields+"}";};
        auto cancel=[&](const String& key,String& detail){return invoice?BitposClient::cancelInvoice(key,detail):BitposClient::cancelWithdraw(key,detail);};
        for(const auto& term:std::vector<std::pair<std::string,Outcome>>{{"cancelled",Outcome::Cancelled},{"expired",Outcome::Expired}}) {
            fresh();const auto reply=response("\"status\":\""+term.first+"\",\"dispatched\":false",KEY);String detail;
            queue(reply);assert(cancel(KEY,detail)==term.second);queue(reply);assert(cancel(KEY,detail)==term.second);assert(postCalls==2 && getCalls==0);assert(handshakes==1);
            for(const auto& r:requests){assert(r.body=="{}");assert(r.headers.at("Authorization")=="Bearer device-test-token");assert(r.headers.at("Content-Type")=="application/json");assert(r.url=="https://openln.com/api/pos/"+std::string(invoice?"invoice/":"withdraw/")+KEY.c_str()+"/cancel");}
        }
        for(const auto& c:std::vector<std::pair<int,std::string>>{{200,response("\"status\":\"cancelled\",\"dispatched\":false",HASH)},{200,response("\"status\":\"cancelled\"",KEY)},{200,response("\"status\":\"cancelled\",\"dispatched\":true",KEY)},{200,response("\"status\":\"cancelled\",\"dispatched\":\"false\"",KEY)},{409,response("\"status\":\"paid\",\"dispatched\":true,\"doNotRetry\":true",KEY)},{409,response("\"status\":\"cancelled\",\"dispatched\":false",KEY)},{202,response("\"status\":\"cancelled\",\"dispatched\":false",KEY)},{404,"{}"},{503,"{}"},{-11,""},{200,response("\"status\":\"cancelled\",\"dispatched\":false",KEY)+"garbage"},{200,response("\"status\":\"cancelled\",\"dispatched\":false,\"doNotRetry\":true",KEY)}}) {
            fresh();queue(c.second,c.first);String detail;assert(cancel(KEY,detail)==Outcome::Pending);assert(postCalls==1);assert(!detail.isEmpty());
        }
        fresh();Response partial;partial.body=response("\"status\":\"cancelled\",\"dispatched\":false",KEY);partial.length=int(partial.body.size()+1);partial.keepAlive=false;responses.push_back(partial);String detail;assert(cancel(KEY,detail)==Outcome::Pending);assert(postCalls==1);
        fresh();assert(cancel(KEY+"/x",detail)==Outcome::NotSubmitted);assert(postCalls==0);
        fresh();beginOk=false;assert(cancel(KEY,detail)==Outcome::Pending);assert(postCalls==0);
    }
}
void metadataAndStatusValidation() {
    fresh();String err;queue(metadata());const auto card=BitposClient::fetchLnurl(CARD,err);
    assert(card.maxWithdrawable==5000000000LL);
    fresh();queue("{\"tag\":\"withdrawRequest\",\"callback\":\"http://unsafe.invalid/pay\",\"k1\":\"c\",\"maxWithdrawable\":1000}");
    BitposClient::fetchLnurl(CARD,err);assert(!err.isEmpty());
    for(const auto& response:std::vector<std::string>{"{\"status\":\"paid\"}","{\"status\":\"paid\",\"paymentHash\":\"wrong\"}","{\"status\":\"paid\",\"paymentHash\":\""+std::string(HASH.c_str())+"\"}bad"}) {
        fresh();queue(response);assert(BitposClient::pollInvoiceStatus(HASH)=="error");
    }
    fresh();queue(sendReply("\"status\":\"pending\",\"dispatched\":true,\"phase\":\"pending\""));assert(BitposClient::pollWithdrawStatus(KEY)=="processing");
    fresh();queue(sendReply("\"status\":\"paid\"",HASH));assert(BitposClient::pollWithdrawStatus(KEY)=="error");
    fresh();queue(sendReply("\"status\":\"expired\",\"dispatched\":true"));assert(BitposClient::pollWithdrawStatus(KEY)=="error");
}
void creationValidation() {
    fresh();String err;queue("{\"bolt11\":\""+std::string(BOLT11.c_str())+"\",\"paymentHash\":\""+std::string(HASH.c_str())+"\",\"amountSats\":100,\"expiresAt\":\"2099-01-01T00:00:00.000Z\"}",201);
    const auto invoice=BitposClient::createInvoice(100,err);assert(err.isEmpty() && invoice.ttlSec==600);
    fresh();queue("{\"bolt11\":\""+std::string(BOLT11.c_str())+"\",\"paymentHash\":\"bad\",\"amountSats\":100}",201);BitposClient::createInvoice(100,err);assert(!err.isEmpty());
    fresh();queue("{\"k1\":\""+std::string(KEY.c_str())+"\",\"lnurlw\":\"lnurl1fixture\"}");String out;
    BitposClient::createWithdraw(100,"123456",err,out,KEY);JsonDocument payload;assert(!deserializeJson(payload,requests[0].body));assert(payload["requestId"]==KEY);
}
int main(){creationValidation();sameOriginReuse();securePublicTransport();boundedCompleteBodies();callbackOutcomes();sendOutcomes();cancellationOutcomes();metadataAndStatusValidation();BitposClient::releaseConnections();std::cout<<"PASS secure transport, typed submissions and proof-only cancellation\n";}
