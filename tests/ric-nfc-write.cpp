#include <array>
#include <algorithm>
#include <cstdint>
#include <cstddef>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
struct NullSerial { template<class T> void print(T){} template<class T> void println(T){} } Serial;
int capacity(uint8_t,uint8_t,uint8_t);
std::array<uint8_t,256> card{};
int calls=0, failAt=0, failureType=0;
class Adafruit_PN532 {
public:
 bool ntag424_ISOUpdateBinary(uint8_t*,uint8_t);
 uint8_t ntag424_apdu_send(uint8_t*,uint8_t*,uint8_t*,uint8_t* p2,uint8_t*,uint8_t headerLength,uint8_t* data,uint8_t length,uint8_t,uint8_t mode,uint8_t* result,uint8_t) {
  ++calls;
  if(!capacity(headerLength,length,mode)) return 0;
  if(calls==failAt) {
   if(failureType==0) return 0;
   result[0]=0x69; result[1]=0x82;
   return failureType==1 ? 2 : 1;
  }
  std::memcpy(card.data()+p2[0],data,length);
  result[0]=0x90; result[1]=0;
  return 2;
 }
};
#include "installed.inc"
void require(bool ok,const char* why){ if(!ok) throw std::runtime_error(why); }
int main(int argc,char** argv) {
 try {
  require(argc==2,"case required");
  const std::string name=argv[1];
  if(name=="plain-54-capacity") {require(capacity(0,54,NTAG424_COMM_MODE_PLAIN)>0,"54-byte plain NDEF chunks must not hit the FULL encryption limit");}
  else if(name=="full-capacity-bounds") {
   require(capacity(7,25,NTAG424_COMM_MODE_FULL)==55,"FULL padding bound changed");
   require(capacity(0,48,NTAG424_COMM_MODE_FULL)==0,"64-byte encrypted payload must remain rejected");
   require(capacity(200,100,NTAG424_COMM_MODE_PLAIN)==0,"APDU stack bound must remain enforced");
  } else {
   Adafruit_PN532 nfc;
   std::array<uint8_t,130> ndef{};
   for(size_t i=0;i<ndef.size();++i) ndef[i]=uint8_t(i+1);
   if(name=="empty-write") require(!nfc.ntag424_ISOUpdateBinary(ndef.data(),0),"empty write must fail without stale status");
   else if(name=="null-write") require(!nfc.ntag424_ISOUpdateBinary(nullptr,5),"null write must fail");
   else {
    uint8_t length=130;
    if(name=="short-write") length=7;
    if(name=="full-chunk-write") length=54;
    if(name=="failure-first" || name=="status-first" || name=="short-response") failAt=1;
    if(name=="failure-middle" || name=="status-middle") failAt=2;
    if(name=="failure-last") failAt=3;
    if(name=="status-first" || name=="status-middle") failureType=1;
    if(name=="short-response") failureType=2;
    const bool ok=nfc.ntag424_ISOUpdateBinary(ndef.data(),length);
    if(failAt) {require(!ok,"failed chunk must not be masked by later success");require(calls==failAt,"write must stop at first failed chunk");}
    else {require(ok,"valid NDEF write failed");require(std::equal(ndef.begin(),ndef.begin()+length,card.begin()),"writer reported success but NDEF bytes are missing on card");}
   }
  }
  std::cout<<"PASS "<<name<<" calls="<<calls<<"\n";
  return 0;
 } catch(const std::exception& e) {std::cerr<<e.what()<<"\n";return 1;}
}
