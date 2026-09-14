#pragma once
#include "Arduino.h"
enum wl_status_t {WL_DISCONNECTED=0,WL_CONNECTED=3};
struct IpShim {String toString(){return "192.0.2.1";}};
struct WiFiShim {
    wl_status_t connection=WL_CONNECTED;
    unsigned reconnects=0,begins=0;
    wl_status_t status(){return connection;}
    void setAutoReconnect(bool){}
    void begin(const char*,const char*){++begins;}
    void disconnect(bool=false){connection=WL_DISCONNECTED;}
    void reconnect(){++reconnects;}
    IpShim localIP(){return {};}
};
inline WiFiShim WiFi;
