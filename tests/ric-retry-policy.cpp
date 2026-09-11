#include <cassert>
#include <cstdint>
#include <iostream>
#include "core/RicPolicy.h"
int main(){
 using namespace RicPolicy;
 assert(elapsed(90000,50000,40000));assert(!elapsed(50100,50000,40000));
 assert(elapsed(100,UINT32_MAX-100,150));
 assert(due(50,UINT32_MAX-20));assert(!due(100,200));
 // Jitter belongs to a retry deadline, not to a last-attempt timestamp.
 assert(!due(60000,60000+40000+1999));
 assert(!managementAllowed(true,true,false));
 assert(!managementAllowed(true,false,true));
 assert(!managementAllowed(false,false,false));
 assert(managementAllowed(true,false,false));
 std::cout<<"PASS monotonic deadlines, rollover, idle-only maintenance\n";
}
