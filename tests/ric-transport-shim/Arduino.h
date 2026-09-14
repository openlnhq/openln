#pragma once
// Host boundary only. BitposClient.cpp and ArduinoJson are compiled unchanged.
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <type_traits>
#define PROGMEM
#define F(x) x
using byte = uint8_t;
class String {
    std::string value_;
public:
    String() = default;
    String(const char* s) : value_(s ? s : "") {}
    String(const char* s, unsigned int n) : value_(s ? std::string(s,n) : "") {}
    String(const std::string& s) : value_(s) {}
    String(char c) : value_(1,c) {}
    template<class T, std::enable_if_t<std::is_integral_v<T> && !std::is_same_v<T,char>,int> = 0>
    String(T n) : value_(std::to_string(n)) {}
    unsigned int length() const { return value_.size(); }
    bool isEmpty() const { return value_.empty(); }
    bool reserve(unsigned int n) { value_.reserve(n); return true; }
    const char* c_str() const { return value_.c_str(); }
    char operator[](unsigned int i) const { return i < value_.size() ? value_[i] : 0; }
    char& operator[](unsigned int i) { return value_[i]; }
    char charAt(unsigned int i) const { return (*this)[i]; }
    bool concat(const char* s,unsigned int n) { value_.append(s,n);return true; }
    bool concat(const char* s) { value_+=s;return true; }
    void clear() {value_.clear();}
    String& operator+=(const String& s) { value_+=s.value_;return *this; }
    String& operator+=(char c) {value_+=c;return *this;}
    friend String operator+(String a,const String& b) {a+=b;return a;}
    friend bool operator==(const String& a,const String& b) {return a.value_==b.value_;}
    friend bool operator!=(const String& a,const String& b) {return !(a==b);}
    void remove(unsigned int a,unsigned int n=~0U) {if(a<value_.size())value_.erase(a,n);}
    String substring(unsigned int a,unsigned int b=~0U) const {a=std::min<unsigned>(a,value_.size());b=std::min<unsigned>(b,value_.size());return value_.substr(a,b>=a?b-a:0);}
    void toLowerCase() {for(char& c:value_)c=std::tolower(static_cast<unsigned char>(c));}
    void toUpperCase() {for(char& c:value_)c=std::toupper(static_cast<unsigned char>(c));}
    void trim() {auto a=value_.find_first_not_of(" \r\n\t");if(a==std::string::npos){clear();return;}value_=value_.substr(a,value_.find_last_not_of(" \r\n\t")-a+1);}
    int indexOf(char c,unsigned int a=0) const {auto n=value_.find(c,a);return n==std::string::npos?-1:int(n);}
    int indexOf(const String& s,unsigned int a=0) const {auto n=value_.find(s.value_,a);return n==std::string::npos?-1:int(n);}
    bool startsWith(const String& s) const {return value_.rfind(s.value_,0)==0;}
    bool endsWith(const String& s) const {return value_.size()>=s.value_.size() && value_.compare(value_.size()-s.value_.size(),s.value_.size(),s.value_)==0;}
    long toInt() const {return std::strtol(c_str(),nullptr,10);}
};
class Print {
public:
    virtual ~Print()=default;
    virtual size_t write(uint8_t)=0;
    virtual size_t write(const uint8_t* p,size_t n) {size_t i=0;for(;i<n && write(p[i]);i++){}return i;}
};
class Stream: public Print {
public:
    virtual int available()=0;
    virtual int read()=0;
    virtual int peek()=0;
    virtual void flush()=0;
    void setTimeout(unsigned long n){timeout_=n;}
    unsigned long getTimeout() const{return timeout_;}
    size_t readBytes(char* p,size_t n){size_t i=0;for(;i<n;i++){int c=read();if(c<0)break;p[i]=char(c);}return i;}
    size_t readBytes(uint8_t* p,size_t n){return readBytes(reinterpret_cast<char*>(p),n);}
private:
    unsigned long timeout_=1000;
};
namespace RicTransportShim {inline uint32_t now=1000;}
inline uint32_t millis(){return RicTransportShim::now;}
inline void delay(uint32_t n){RicTransportShim::now+=n;}
inline void yield(){}
