#pragma once
#include "SPI.h"
struct TS_Point {int x=1000,y=1000,z=1;};
namespace RicMainShim {inline bool touched=false;inline TS_Point point;inline unsigned touchReads=0;}
class XPT2046_Touchscreen {public: XPT2046_Touchscreen(int,int){} void begin(SPIClass&){} bool touched(){++RicMainShim::touchReads;return RicMainShim::touched;} TS_Point getPoint(){return RicMainShim::point;} };
