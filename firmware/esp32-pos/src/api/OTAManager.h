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
  DeviceLink::release();WiFiClientSecure client;HTTPClient http;DeviceLink::configure(client,http);
  if(!http.begin(client,url)){client.stop();return fail(tft,"download_begin",true,targetVersion);}
  const char* keys[]={"Content-Encoding"};http.collectHeaders(keys,1);http.addHeader("Accept-Encoding","identity");
  code=http.GET();
  if(code!=200 || http.header("Content-Encoding").length() || !RicPolicy::validImage(expected,http.getSize(),next->size)){
   http.end();client.stop();return fail(tft,"download_headers_"+String(code),true,targetVersion);
  }
  if(!Update.begin(expected,U_FLASH)){http.end();client.stop();return fail(tft,"flash_begin_"+String(Update.getError()),true,targetVersion);}
  mbedtls_sha256_context hash;mbedtls_sha256_init(&hash);mbedtls_sha256_starts_ret(&hash,0);
  WiFiClient* stream=http.getStreamPtr();uint8_t buffer[1024];uint32_t written=0,lastData=millis(),start=lastData;int lastPercent=-1;
  String error;
  while(written<expected){
   esp_task_wdt_reset();int available=stream->available();
   if(available>0){
    const size_t amount=written==0 ? std::min(sizeof(buffer),static_cast<size_t>(expected)) : std::min(static_cast<size_t>(available),std::min(sizeof(buffer),static_cast<size_t>(expected-written)));
    int received=stream->readBytes(buffer,amount);
    if(received<=0){error="read_failed";break;}
    if(written==0 && (received<14 || buffer[0]!=0xe9 || buffer[12]!=0 || buffer[13]!=0)){error="invalid_image";break;}
    if(Update.write(buffer,received)!=static_cast<size_t>(received)){error="flash_write_"+String(Update.getError());break;}
    mbedtls_sha256_update_ret(&hash,buffer,received);written+=received;lastData=millis();
    int percent=static_cast<int>((uint64_t(written)*100)/expected);
    if(percent/10!=lastPercent/10 || lastPercent<0){
     Serial.printf("RIC OTA: progress=%d written=%u/%u\n",percent,written,expected);
     tft.fillRect(16,SCREEN_H/2+54,SCREEN_W-32,22,COL_BG);tft.setTextDatum(MC_DATUM);tft.setTextColor(COL_TEXT,COL_BG);tft.setTextFont(FONT_SMALL);
     tft.drawString(String(percent)+"%",SCREEN_W/2,SCREEN_H/2+64);lastPercent=percent;
    }
   }else{
    if(!http.connected()){error="download_truncated";break;}
    if(millis()-lastData>15000){error="download_stalled";break;}
    delay(5);
   }
   if(millis()-start>180000){error="download_timeout";break;}
  }
  uint8_t digest[32];mbedtls_sha256_finish_ret(&hash,digest);mbedtls_sha256_free(&hash);
  char actual[65];for(int i=0;i<32;i++)snprintf(actual+2*i,3,"%02x",digest[i]);actual[64]=0;
  http.end();client.stop();
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
