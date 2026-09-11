#pragma once
#include <cstdint>
#include <cstring>
namespace RicPolicy {
enum class AuthState { Accepted, Rejected, Retry };
inline AuthState classifyHello(int code,bool validBody){
 if(code==200 && validBody)return AuthState::Accepted;
 if(code==401 || code==403)return AuthState::Rejected;
 return AuthState::Retry;
}
inline bool parseVersion(const char* text,uint32_t(&v)[3]){
 if(!text)return false;
 for(int i=0;i<3;i++){
  if(*text<'0'||*text>'9')return false;
  v[i]=0;unsigned digits=0;
  while(*text>='0'&&*text<='9'){
   if(++digits>5)return false;
   v[i]=v[i]*10+(*text++-'0');
  }
  if(i<2){if(*text++!='.')return false;}
 }
 return *text=='\0';
}
inline bool newerVersion(const char* next,const char* current){
 uint32_t a[3],b[3];if(!parseVersion(next,a)||!parseVersion(current,b))return false;
 for(int i=0;i<3;i++){if(a[i]!=b[i])return a[i]>b[i];}
 return false;
}
inline bool validImage(uint32_t expected,uint32_t httpSize,uint32_t slotSize){
 return expected>0 && expected==httpSize && expected<=slotSize;
}
inline bool validBase(const char* base){
 return base && (!std::strcmp(base,"https://openln.com/api")||!std::strcmp(base,"https://dev.openln.com/api"));
}
inline bool sameOriginImage(const char* base,const char* url){
 if(!validBase(base)||!url)return false;
 const size_t n=std::strlen(base);
 if(std::strncmp(base,url,n)||std::strncmp(url+n,"/firmware/",10))return false;
 const size_t len=std::strlen(url);if(len<4||std::strcmp(url+len-4,".bin"))return false;
 for(const char* p=url+n+10;*p;p++)if(!((*p>='a'&&*p<='z')||(*p>='0'&&*p<='9')||*p=='/'||*p=='-'||*p=='.'))return false;
 return !std::strstr(url+n,"..");
}
struct HeaderLayout {int badgeX;int dotX;int clearStart;};
inline HeaderLayout headerLayout(int wordX,int wordWidth,bool send){
 int badgeX=wordX+wordWidth+8;int dotX=send?badgeX+38+9:wordX+wordWidth+10;
 return {badgeX,dotX,dotX+10};
}
}
