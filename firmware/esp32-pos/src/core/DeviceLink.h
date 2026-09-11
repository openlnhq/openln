#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include <esp_ota_ops.h>
#include <time.h>
#include "RicPolicy.h"
#include "Version.h"
#include "ServerTrust.h"
#include "../config/Config.h"
#include "../api/BitposClient.h"

// One TLS transaction at a time. The regular POS socket is explicitly released
// before management/OTA. end() alone does NOT close Arduino keep-alive sockets.
class DeviceLink {
public:
 static String& bootId(){static String id=String(esp_random(),HEX)+String(esp_random(),HEX);return id;}
 static void release(){BitposClient::releaseConnections();}
 static bool clockReady(){
  if(time(nullptr)>1700000000)return true;
  configTime(0,0,"time.cloudflare.com","pool.ntp.org","time.google.com");
  const uint32_t start=millis();
  while(time(nullptr)<1700000000 && millis()-start<12000){esp_task_wdt_reset();delay(50);}
  return time(nullptr)>1700000000;
 }
 static bool trustedUrl(const String& url){
  if(!RicPolicy::validBase(Config::serverUrl.c_str()))return false;
  return url.startsWith(Config::serverUrl+"/");
 }
 static void configure(WiFiClientSecure& client,HTTPClient& http){
  client.setCACert(RIC_ROOT_CA);client.setHandshakeTimeout(10);
  http.setReuse(false);http.setTimeout(10000);http.setConnectTimeout(10000);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);http.useHTTP10(true);
  http.setUserAgent(String("openLN-RIC/")+FIRMWARE_VERSION);
 }
 static void identity(JsonDocument& doc){
  doc["firmwareVersion"]=FIRMWARE_VERSION;doc["board"]=RIC_BOARD;
  doc["partitionLayout"]=RIC_PARTITION_LAYOUT;doc["mac"]=WiFi.macAddress();
  doc["bootId"]=bootId();doc["uptimeMs"]=millis();
  const auto part=esp_ota_get_running_partition();
  if(part)doc["runningPartition"]=part->label;
 }
 static int jsonRequest(const char* path,const char* method,const String& payload,JsonDocument& result){
  release();result.clear();
  if(!RicPolicy::validBase(Config::serverUrl.c_str()) || WiFi.status()!=WL_CONNECTED || !clockReady())return -1;
  const String url=Config::serverUrl+path;
  WiFiClientSecure client;HTTPClient http;configure(client,http);
  if(!http.begin(client,url)){client.stop();return -1;}
  http.addHeader("Authorization",String("Bearer ")+Config::token);
  http.addHeader("Accept","application/json");http.addHeader("Accept-Encoding","identity");
  http.addHeader("X-RIC-Version",FIRMWARE_VERSION);
  int code;
  if(!strcmp(method,"POST")){http.addHeader("Content-Type","application/json");code=http.POST(payload);}
  else code=http.GET();
  if(code==200){
   int size=http.getSize();
   if(size<=0 || size>4096){code=-2;}
   else {
    String response;response.reserve(size);uint32_t start=millis(),lastByte=start;
    WiFiClient* stream=http.getStreamPtr();char chunk[256];
    while(response.length()<static_cast<size_t>(size)){
     esp_task_wdt_reset();int available=stream->available();
     if(available>0){
      size_t n=std::min(static_cast<size_t>(available),std::min(sizeof(chunk),static_cast<size_t>(size)-response.length()));
      int got=stream->readBytes(chunk,n);if(got<=0){code=-2;break;}
      response.concat(chunk,got);lastByte=millis();
     }else{
      if(!http.connected() || millis()-lastByte>5000){code=-2;break;}
      delay(5);
     }
     if(millis()-start>10000){code=-2;break;}
    }
    if(response.length()!=static_cast<size_t>(size)||deserializeJson(result,response))code=-2;
   }
  }
  http.end();client.stop();esp_task_wdt_reset();return code;
 }
 static RicPolicy::AuthState hello(){
  JsonDocument doc;identity(doc);String body;serializeJson(doc,body);
  JsonDocument reply;int code=jsonRequest("/ric/hello","POST",body,reply);
  bool valid=reply["status"].is<const char*>() && !strcmp(reply["status"],"ok") && reply["deviceId"].is<const char*>();
  auto state=RicPolicy::classifyHello(code,valid);
  Serial.printf("RIC auth: http=%d state=%s heap=%u largest=%u\n",code,state==RicPolicy::AuthState::Accepted?"accepted":state==RicPolicy::AuthState::Rejected?"rejected":"retry",ESP.getFreeHeap(),ESP.getMaxAllocHeap());
  return state;
 }
 static bool report(const String& state,const String& code,const String& target=""){
  JsonDocument doc;identity(doc);doc["ota"]["state"]=state;doc["ota"]["code"]=code;
  if(target.length())doc["ota"]["targetVersion"]=target;
  String body;serializeJson(doc,body);JsonDocument reply;
  return jsonRequest("/ric/status","POST",body,reply)==200;
 }
};
