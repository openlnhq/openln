#pragma once
#include "WiFiClientSecure.h"
#define HTTPC_ERROR_CONNECTION_REFUSED -1
#define HTTPC_ERROR_SEND_HEADER_FAILED -2
#define HTTPC_ERROR_SEND_PAYLOAD_FAILED -3
#define HTTPC_ERROR_CONNECTION_LOST -5
#define HTTPC_ERROR_READ_TIMEOUT -11
enum followRedirects_t {HTTPC_DISABLE_FOLLOW_REDIRECTS,HTTPC_STRICT_FOLLOW_REDIRECTS,HTTPC_FORCE_FOLLOW_REDIRECTS};
class HTTPClient {
    WiFiClientSecure* client_=nullptr;
    std::string url_,authorization_;
    std::map<std::string,std::string> headers_;
    RicTransportShim::Response response_;
    bool reuse_=true;
    uint32_t connectTimeout_=5000,timeout_=5000;
    followRedirects_t redirects_=HTTPC_DISABLE_FOLLOW_REDIRECTS;
    int request(const char* method,const std::string& body){
        using namespace RicTransportShim;
        if(!client_)throw std::runtime_error("request without begin");
        if(responses.empty())throw std::runtime_error("unexpected network request: "+url_);
        response_=responses.front();responses.pop_front();
        const auto end=url_.find('/',8);const auto authority=url_.substr(0,end);
        if(!client_->connectFor(authority,response_.tlsValid))return -1;
        auto h=headers_;
        if(!authorization_.empty())h["Authorization"]="Basic "+authorization_;
        if(!body.empty())h["Content-Length"]=std::to_string(body.size());
        requests.push_back({method,url_,body,h,client_->id,!client_->insecure&&!client_->ca.empty(),connectTimeout_,client_->tlsTimeout,timeout_,int(redirects_)});
        client_->wire=response_.raw.empty()?response_.body:response_.raw;client_->at=0;
        client_->nextByte=now;client_->byteDelay=response_.byteDelay;client_->keepAlive=response_.keepAlive;
        return response_.code;
    }
public:
    bool begin(WiFiClientSecure& c,const String& url){client_=&c;url_=url.c_str();return RicTransportShim::beginOk;}
    void end(){if(client_){client_->flush();if(!reuse_ || !response_.keepAlive)client_->stop();}headers_.clear();}
    void setReuse(bool x){reuse_=x;}
    void setTimeout(uint16_t x){timeout_=x;}
    void setConnectTimeout(int32_t x){connectTimeout_=x;}
    void setFollowRedirects(followRedirects_t x){redirects_=x;}
    void setUserAgent(const String&){}
    void setAuthorization(const char* s){if(s)authorization_=s;}
    void setAuthorizationType(const char*){}
    void setCookieJar(void*){}
    void resetCookieJar(){}
    void addHeader(const String& k,const String& v,bool=false,bool=true){headers_[k.c_str()]=v.c_str();}
    void collectHeaders(const char*[],size_t){}
    String header(const char* key){
        if(std::string(key)=="Transfer-Encoding")return response_.transferEncoding;
        if(std::string(key)=="Content-Length")return response_.length==-1?String():String(getSize());
        auto it=response_.headers.find(key);return it==response_.headers.end()?String():String(it->second);
    }
    bool hasHeader(const char* key){return !header(key).isEmpty();}
    bool connected(){return client_&&client_->connected();}
    int getSize(){return response_.length==-2?int(response_.body.size()):response_.length;}
    Stream& getStream(){return *client_;}
    WiFiClientSecure* getStreamPtr(){return client_;}
    int GET(){++RicTransportShim::getCalls;return request("GET","");}
    int POST(uint8_t* p,size_t n){++RicTransportShim::postCalls;return request("POST",std::string(reinterpret_cast<char*>(p),n));}
    String getString(){++RicTransportShim::getStringCalls;if(client_)client_->flush();return response_.body;}
};
