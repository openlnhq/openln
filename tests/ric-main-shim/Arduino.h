#pragma once
// Host-only boundary based on ric-display/adapters/Arduino.h. No ESP/IO code.
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <sstream>
#include <string>
#include <type_traits>
#include <vector>
#include <stdexcept>
#define PROGMEM
#define F(x) x
#define SET_LOOP_TASK_STACK_SIZE(x)
#define INPUT_PULLUP 2
#define HIGH 1
#define LOW 0
using byte = uint8_t;
using boolean = bool;
using std::min;
using std::max;
using std::abs;
class String {
    std::string value_;
public:
    String() = default;
    String(const char* v) : value_(v ? v : "") {}
    String(const std::string& v) : value_(v) {}
    String(char v) : value_(1, v) {}
    template<class T, std::enable_if_t<std::is_integral_v<T> && !std::is_same_v<T,char>,int> = 0>
    String(T v) : value_(std::to_string(v)) {}
    String(double v, unsigned char places = 2) { std::ostringstream s; s << std::fixed << std::setprecision(places) << v; value_ = s.str(); }
    unsigned int length() const { return value_.size(); }
    bool isEmpty() const { return value_.empty(); }
    bool reserve(unsigned int n) { value_.reserve(n); return true; }
    const char* c_str() const { return value_.c_str(); }
    char operator[](unsigned int i) const { return i < value_.size() ? value_[i] : 0; }
    char charAt(unsigned int i) const { return (*this)[i]; }
    String& operator+=(const String& s) { value_ += s.value_; return *this; }
    String& operator+=(char c) { value_ += c; return *this; }
    friend String operator+(String a, const String& b) { a += b; return a; }
    friend bool operator==(const String& a, const String& b) { return a.value_ == b.value_; }
    friend bool operator!=(const String& a, const String& b) { return !(a == b); }
    void remove(unsigned int from, unsigned int count = ~0U) { if (from < value_.size()) value_.erase(from,count); }
    String substring(unsigned int a, unsigned int b = ~0U) const { if (a>b) std::swap(a,b); a=std::min<unsigned int>(a,value_.size()); b=std::min<unsigned int>(b,value_.size()); return value_.substr(a,b-a); }
    void toUpperCase() { for (char& c:value_) c=std::toupper(static_cast<unsigned char>(c)); }
    void toLowerCase() { for (char& c:value_) c=std::tolower(static_cast<unsigned char>(c)); }
    void trim() { auto a=value_.find_first_not_of(" \r\n\t"); if(a==std::string::npos){value_.clear();return;} value_=value_.substr(a,value_.find_last_not_of(" \r\n\t")-a+1); }
    void toCharArray(char* out,unsigned int n) const { if(n){std::strncpy(out,value_.c_str(),n-1);out[n-1]=0;} }
    int indexOf(char c,unsigned int from=0) const { auto n=value_.find(c,from);return n==std::string::npos?-1:static_cast<int>(n); }
    int indexOf(const String& s,unsigned int from=0) const { auto n=value_.find(s.value_,from);return n==std::string::npos?-1:static_cast<int>(n); }
    bool startsWith(const String& s) const { return value_.rfind(s.value_,0)==0; }
    bool endsWith(const String& s) const { return value_.size()>=s.value_.size() && value_.compare(value_.size()-s.value_.size(),s.value_.size(),s.value_)==0; }
    long toInt() const { return std::strtol(value_.c_str(),nullptr,10); }
    float toFloat() const { return std::strtof(value_.c_str(),nullptr); }
    auto begin() const {return value_.begin();} auto end() const {return value_.end();}
};
namespace RicMainShim {
inline uint32_t now=1000;
inline std::vector<uint32_t> delays;
inline std::string worker;
inline unsigned watchdogFeeds=0, displayWrites=0, socketAttempts=0, restarts=0;
inline bool strictIo=false;
inline std::vector<std::string> displayText, serialLines;
inline void ui() { if(!worker.empty()) throw std::runtime_error("Worker touched UI: "+worker); ++displayWrites; }
}
inline uint32_t millis() {return RicMainShim::now;}
inline void delay(uint32_t n) {RicMainShim::delays.push_back(n);RicMainShim::now+=n;}
inline void yield() {}
inline long map(long x,long a,long b,long c,long d){return (x-a)*(d-c)/(b-a)+c;}
template<class T> inline T constrain(T x,T a,T b){return std::min(std::max(x,a),b);}
inline void pinMode(int,int) {}
inline int digitalRead(int) {return HIGH;}
inline void ledcSetup(int,int,int) {}
inline void ledcAttachPin(int,int) {}
inline void ledcWrite(int,int) {}
inline uint32_t esp_random(){return 0x19;}
inline int esp_reset_reason(){return 1;}
struct SerialShim {
    void begin(int){}
    template<class... T> void printf(const char* format,T... args){
        char text[512];std::snprintf(text,sizeof(text),format,args...);RicMainShim::serialLines.emplace_back(text);
    }
    template<class T> void print(T){} template<class T> void println(T){}
};
inline SerialShim Serial;
struct EspShim {void restart(){++RicMainShim::restarts;} unsigned getFreeHeap(){return 100000;} unsigned getMaxAllocHeap(){return 64000;} };
inline EspShim ESP;
