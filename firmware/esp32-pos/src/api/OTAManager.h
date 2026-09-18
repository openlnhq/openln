#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Update.h>
#include <Preferences.h>
#include <esp_ota_ops.h>
#include <mbedtls/sha256.h>
#include "../core/DeviceLink.h"
#include "../ui/Theme.h"

class OTAManager {
public:
 static String& lastStatus(){static String value="Not checked";return value;}
 static String& lastCode(){static String value="not_checked";return value;}
 static String& lastConfirmedTarget(){static String value;return value;}
 static void display(TFT_eSPI& tft,const String& title,const String& detail){
  ledcWrite(0,255);tft.fillScreen(COL_BG);tft.setTextDatum(MC_DATUM);
  tft.setTextFont(FONT_MED);tft.setTextColor(COL_ACCENT,COL_BG);
  tft.drawString(title,SCREEN_W/2,SCREEN_H/2-24);
  tft.setTextFont(FONT_SMALL);tft.setTextColor(COL_TEXT,COL_BG);
  tft.drawString(detail,SCREEN_W/2,SCREEN_H/2+4);
  tft.setTextColor(COL_MUTED,COL_BG);tft.drawString(String("Installed v")+FIRMWARE_VERSION,SCREEN_W/2,SCREEN_H/2+30);
 }
 static void bootConfirmed(){
  Preferences prefs;if(!prefs.begin("ric-update",false))return;
  String target=prefs.isKey("target")?prefs.getString("target",""):String();prefs.end();
  if(target.length()){
   bool same=target==FIRMWARE_VERSION;
   if(same)lastConfirmedTarget()=target;
   lastStatus()=same?"Update confirmed":"Previous firmware retained";
   lastCode()=same?"boot_confirmed":"boot_mismatch";
   if(DeviceLink::report(same?"confirmed":"failed",lastCode(),target)){
    if(prefs.begin("ric-update",false)){prefs.remove("target");prefs.end();}
   }
  }
 }
 static bool checkAndUpdate(TFT_eSPI& tft,bool manual=false){
  lastStatus()="Checking for updates";lastCode()="checking";
  Serial.printf("RIC OTA: check installed=%s heap=%u largest=%u\n",FIRMWARE_VERSION,ESP.getFreeHeap(),ESP.getMaxAllocHeap());
  if(manual)display(tft,"Checking updates", "Secure connection to openLN");
  JsonDocument meta;
  int code=DeviceLink::jsonRequest("/firmware/posbox-version","GET","",meta);
  if(code!=200)return fail(tft,"metadata_http_"+String(code),manual);
  const char* target=meta["version"]|"";
  uint32_t a[3],b[3];
  if(!RicPolicy::parseVersion(target,a)||!RicPolicy::parseVersion(FIRMWARE_VERSION,b))return fail(tft,"invalid_version",manual);
  if(!RicPolicy::newerVersion(target,FIRMWARE_VERSION)){
   lastStatus()=String("Up to date: v")+FIRMWARE_VERSION;lastCode()="up_to_date";
   Serial.printf("RIC OTA: up_to_date installed=%s offered=%s\n",FIRMWARE_VERSION,target);
   if(lastConfirmedTarget()!=FIRMWARE_VERSION)DeviceLink::report("up_to_date","up_to_date",target);
   if(manual){display(tft,"Up to date",String("Version ")+FIRMWARE_VERSION);delay(1400);}return false;
  }
  String targetVersion=target;String url=meta["url"]|"";String expectedSha=meta["sha256"]|"";
  if(strcmp(meta["board"]|"",RIC_BOARD)||strcmp(meta["partitionLayout"]|"",RIC_PARTITION_LAYOUT))return fail(tft,"board_or_layout",true,targetVersion);
  if(!RicPolicy::sameOriginImage(Config::serverUrl.c_str(),url.c_str())||expectedSha.length()!=64)return fail(tft,"invalid_manifest",true,targetVersion);
  for(char c:expectedSha)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return fail(tft,"invalid_digest",true,targetVersion);
  uint32_t expected=meta["bytes"]|0U;
  const auto running=esp_ota_get_running_partition();const auto next=esp_ota_get_next_update_partition(nullptr);
  if(!running||!next||next->address==running->address||!expected||expected>next->size)return fail(tft,"no_compatible_slot",true,targetVersion);
  DeviceLink::report("downloading","started",targetVersion);
  display(tft,String("Updating to v")+targetVersion,"Do not disconnect power");
  Serial.printf("RIC OTA: download target=%s bytes=%u slot=%s heap=%u largest=%u\n",targetVersion.c_str(),expected,next->label,ESP.getFreeHeap(),ESP.getMaxAllocHeap());
  if(!Update.begin(expected,U_FLASH))return fail(tft,"flash_begin_"+String(Update.getError()),true,targetVersion);
  mbedtls_sha256_context hash;mbedtls_sha256_init(&hash);mbedtls_sha256_starts_ret(&hash,0);
  // Resumable download in bounded chunks (HTTP Range). Field links here are
  // ~300 ms RTT with a small TCP window: the whole 1.3 MB image in one GET
  // took minutes and any hiccup restarted from zero (the 2026-09-18 "stuck at
  // 0%" incident). Per chunk: fresh TLS session, one Range request, verify
  // the 206 window, write to flash, hash. A stall costs one chunk, not the
  // update. The full-image SHA-256 is still checked before the slot switch.
  const uint32_t CHUNK=131072;const int MAX_CHUNK_RETRIES=6;const uint32_t TOTAL_DEADLINE_MS=15UL*60UL*1000UL;
  uint8_t buffer[1024];uint32_t written=0,start=millis();int lastPercent=-1;int retries=0;String error;
  while(written<expected){
   if(millis()-start>TOTAL_DEADLINE_MS){error="download_timeout";break;}
   const uint32_t rangeEnd=std::min(expected-1,written+CHUNK-1);
   DeviceLink::release();WiFiClientSecure client;HTTPClient http;DeviceLink::configure(client,http);
   if(!http.begin(client,url)){client.stop();if(++retries>MAX_CHUNK_RETRIES){error="download_begin";break;}delay(1000*retries);continue;}
   const char* keys[]={"Content-Encoding","Content-Range"};http.collectHeaders(keys,2);
   http.addHeader("Accept-Encoding","identity");http.addHeader("Range",String("bytes=")+written+"-"+rangeEnd);
   code=http.GET();
   char want[64];snprintf(want,sizeof(want),"bytes %u-%u/%u",written,rangeEnd,expected);
   const uint32_t chunkLen=rangeEnd-written+1;
   if(code!=206 || http.header("Content-Encoding").length() || http.header("Content-Range")!=want || http.getSize()!=static_cast<int>(chunkLen)){
    http.end();client.stop();
    Serial.printf("RIC OTA: chunk headers http=%d range=%s retry=%d\n",code,http.header("Content-Range").c_str(),retries+1);
    if(code==200 || code==416 || code==404){error="download_headers_"+String(code);break;}   // server does not do ranges / image changed
    if(++retries>MAX_CHUNK_RETRIES){error="download_headers_"+String(code);break;}
    delay(1000*retries);continue;
   }
   WiFiClient* stream=http.getStreamPtr();uint32_t got=0,lastData=millis();bool chunkFailed=false;
   while(got<chunkLen){
    esp_task_wdt_reset();int available=stream->available();
    if(available>0){
     const size_t amount=std::min(static_cast<size_t>(available),std::min(sizeof(buffer),static_cast<size_t>(chunkLen-got)));
     int received=stream->readBytes(buffer,amount);
     if(received<=0){chunkFailed=true;break;}
     if(written==0 && got==0 && (received<14 || buffer[0]!=0xe9 || buffer[12]!=0 || buffer[13]!=0)){error="invalid_image";break;}
     if(Update.write(buffer,received)!=static_cast<size_t>(received)){error="flash_write_"+String(Update.getError());break;}
     mbedtls_sha256_update_ret(&hash,buffer,received);got+=received;written+=received;lastData=millis();
     int percent=static_cast<int>((uint64_t(written)*100)/expected);
     if(percent/5!=lastPercent/5 || lastPercent<0){
      Serial.printf("RIC OTA: progress=%d written=%u/%u heap=%u\n",percent,written,expected,ESP.getFreeHeap());
      tft.fillRect(16,SCREEN_H/2+54,SCREEN_W-32,22,COL_BG);tft.setTextDatum(MC_DATUM);tft.setTextColor(COL_TEXT,COL_BG);tft.setTextFont(FONT_SMALL);
      tft.drawString(String(percent)+"%",SCREEN_W/2,SCREEN_H/2+64);lastPercent=percent;
     }
    }else{
     if(!http.connected() || millis()-lastData>12000){chunkFailed=true;break;}
     delay(5);
    }
   }
   http.end();client.stop();
   if(error.length())break;
   if(chunkFailed){
    // Partial chunk: bytes already written and hashed are kept; resume from
    // `written`. Give the link a moment before asking again.
    Serial.printf("RIC OTA: chunk stalled at %u/%u retry=%d\n",written,expected,retries+1);
    if(++retries>MAX_CHUNK_RETRIES){error="download_stalled";break;}
    delay(1500*retries);continue;
   }
   retries=0;
  }
  uint8_t digest[32];mbedtls_sha256_finish_ret(&hash,digest);mbedtls_sha256_free(&hash);
  char actual[65];for(int i=0;i<32;i++)snprintf(actual+2*i,3,"%02x",digest[i]);actual[64]=0;
  if(error.isEmpty() && (written!=expected || expectedSha!=actual))error="digest_mismatch";
  if(error.length()){Update.abort();return fail(tft,error,true,targetVersion);}
  Preferences prefs;
  if(!prefs.begin("ric-update",false)){Update.abort();return fail(tft,"journal_open",true,targetVersion);}
  const bool stored=prefs.putString("target",targetVersion)>0;prefs.end();
  if(!stored){Update.abort();return fail(tft,"journal_write",true,targetVersion);}
  if(!Update.end()){int err=Update.getError();Update.abort();return fail(tft,"flash_finalize_"+String(err),true,targetVersion);}
  lastStatus()="Rebooting into update";lastCode()="rebooting";
  Serial.printf("RIC OTA: verified target=%s sha256=%s next=%s rebooting\n",targetVersion.c_str(),actual,next->label);
  DeviceLink::report("rebooting","verified",targetVersion);
  display(tft,"Update verified","Restarting device");delay(1200);ESP.restart();return true;
 }
private:
 static bool fail(TFT_eSPI& tft,const String& reason,bool show,const String& target=""){
  lastStatus()="Update not installed";lastCode()=reason;
  Serial.printf("RIC OTA: failed code=%s target=%s; current firmware retained heap=%u largest=%u\n",reason.c_str(),target.c_str(),ESP.getFreeHeap(),ESP.getMaxAllocHeap());
  DeviceLink::report("failed",reason,target);
  if(show){display(tft,"Update not installed",reason);delay(2200);}return false;
 }
};
