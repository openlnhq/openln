#include <cassert>
#include <iostream>
#include "core/RicPolicy.h"
int main(){
 using namespace RicPolicy;
 assert(classifyHello(200,true)==AuthState::Accepted);
 for(int status : {-11,-1,0,200,301,404,429,500,503}) assert(classifyHello(status,false)==AuthState::Retry);
 assert(classifyHello(401,false)==AuthState::Rejected);
 assert(classifyHello(403,false)==AuthState::Rejected);
 assert(newerVersion("1.0.4","1.0.3"));
 assert(!newerVersion("1.0.3","1.0.3"));
 assert(!newerVersion("1.0.2","1.0.3"));
 assert(newerVersion("1.10.0","1.9.99"));
 assert(!newerVersion("junk","1.0.3"));
 assert(!newerVersion("1.2.3evil","1.0.3"));
 assert(!newerVersion("1.0.3",""));
 assert(validImage(1000,1000,1966080));
 assert(!validImage(0,0,1966080));
 assert(!validImage(1001,1000,1966080));
 assert(!validImage(2000000,2000000,1966080));
 assert(validBase("https://openln.com/api"));
 assert(validBase("https://dev.openln.com/api"));
 assert(!validBase("http://openln.com/api"));
 assert(!validBase("https://evil.example/api"));
 assert(!validBase("https://openln.com.evil/api"));
 assert(sameOriginImage("https://openln.com/api","https://openln.com/api/firmware/ric/abc.bin"));
 assert(!sameOriginImage("https://openln.com/api","https://dev.openln.com/api/firmware/ric/abc.bin"));
 assert(!sameOriginImage("https://openln.com/api","https://evil.example/firmware.bin"));
 assert(!sameOriginImage("https://openln.com/api","http://openln.com/api/firmware/x.bin"));
 assert(!sameOriginImage("https://openln.com/api","https://openln.com/api/firmware/../foo.bin"));
 assert(!sameOriginImage("https://openln.com/api","https://openln.com/api/firmware/x.bin?x"));
 auto receive=headerLayout(24,52,false);auto send=headerLayout(24,52,true);
 assert(receive.dotX-3>24+52);assert(receive.clearStart>receive.dotX+3);
 assert(send.badgeX>24+52);assert(send.dotX-3>send.badgeX+38);assert(send.clearStart>send.dotX+3);
 std::cout<<"PASS auth retry/rejection, strict version ordering, image bounds, origin restrictions, header spacing\n";
}
