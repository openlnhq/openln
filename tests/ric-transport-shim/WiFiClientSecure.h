#pragma once
#include "Arduino.h"
#include <map>
#include <deque>
#include <vector>
#include <stdexcept>
namespace RicTransportShim {
struct Response {
    int code=200;
    std::string body="{}";
    int length=-2; // -2 = real content length, -1 = absent
    std::string transferEncoding;
    std::string raw; // explicit framed wire data for chunked tests
    bool keepAlive=true;
    bool tlsValid=true;
    uint32_t byteDelay=0;
    std::map<std::string,std::string> headers;
};
struct Request {
    std::string method,url,body;
    std::map<std::string,std::string> headers;
    unsigned client=0;
    bool trusted=false;
    uint32_t connectTimeout=0,tlsTimeout=0,bodyTimeout=0;
    int redirects=-1;
};
inline std::deque<Response> responses;
inline std::vector<Request> requests;
inline unsigned handshakes=0,live=0,maxLive=0,insecureCalls=0,getStringCalls=0,getCalls=0,postCalls=0;
inline unsigned nextClient=0;
inline bool beginOk=true;
inline void reset(){responses.clear();requests.clear();handshakes=live=maxLive=insecureCalls=getStringCalls=getCalls=postCalls=0;beginOk=true;now=1000;}
inline void queue(std::string body,int code=200){Response r;r.body=std::move(body);r.code=code;responses.push_back(r);}
}
class WiFiClientSecure: public Stream {
public:
    unsigned id=++RicTransportShim::nextClient;
    bool live=false,insecure=false;
    std::string ca,host,wire;
    size_t at=0;
    uint32_t tlsTimeout=0,nextByte=0,byteDelay=0;
    bool keepAlive=true;
    void setCACert(const char* s){ca=s?s:"";insecure=false;}
    void setInsecure(){insecure=true;++RicTransportShim::insecureCalls;}
    void setHandshakeTimeout(unsigned n){tlsTimeout=n;}
    void stop(){if(live){live=false;--RicTransportShim::live;}wire.clear();at=0;}
    bool connectFor(const std::string& target,bool valid){
        if(live && host!=target)stop();
        if(!live){if(!valid && !insecure)return false;live=true;host=target;++RicTransportShim::handshakes;++RicTransportShim::live;RicTransportShim::maxLive=std::max(RicTransportShim::maxLive,RicTransportShim::live);}
        return true;
    }
    bool connected(){return live && (keepAlive || at<wire.size());}
    int available() override {return int32_t(RicTransportShim::now-nextByte)>=0?int(wire.size()-at):0;}
    int read() override {if(!available())return -1;int c=uint8_t(wire[at++]);nextByte=RicTransportShim::now+byteDelay;return c;}
    int peek() override {return available()?uint8_t(wire[at]):-1;}
    void flush() override {at=wire.size();}
    size_t write(uint8_t) override {return 1;}
    using Stream::write;
};
using WiFiClient=WiFiClientSecure;
