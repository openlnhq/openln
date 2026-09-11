#!/usr/bin/env python3
"""Package the built CYD firmware from its actual partition table, not guessed offsets."""
import hashlib,json,re,struct,subprocess
from pathlib import Path
root=Path(__file__).resolve().parent.parent
fw=root/'firmware';src=fw/'esp32-pos';build=src/'.pio/build/esp32dev'
match=re.search(r'#define FIRMWARE_VERSION "([0-9]+\.[0-9]+\.[0-9]+)"',(src/'src/core/Version.h').read_text())
assert match, "Missing firmware version"
version=match[1]
parts={}
table=(build/'partitions.bin').read_bytes()
for off in range(0,len(table)-31,32):
 magic,typ,sub,addr,size,label,flags=struct.unpack('<HBBII16sI',table[off:off+32])
 if magic!=0x50aa:break
 parts[label.split(b'\0')[0].decode()]=(addr,size)
assert parts['app0']==(0x20000,0x1e0000) and parts['app1']==(0x200000,0x1e0000)
assert parts['otadata']==(0x16000,0x2000)
app=(build/'firmware.bin').read_bytes();assert app[0]==0xe9 and int.from_bytes(app[12:14],'little')==0 and len(app)<parts['app0'][1]
assert (version+'\0').encode() in app
# Boot-app0 initialization belongs at otadata, not the legacy 0xe000.
pio=Path.home()/'.platformio/packages'
subprocess.run([str(Path.home()/'.venv-pio/bin/python'),str(pio/'tool-esptoolpy/esptool.py'),'--chip','esp32','merge_bin','-o',str(fw/'posbox-latest.bin'),'--flash_mode','dio','--flash_freq','40m','0x1000',str(build/'bootloader.bin'),'0x8000',str(build/'partitions.bin'),hex(parts['otadata'][0]),str(pio/'framework-arduinoespressif32/tools/partitions/boot_app0.bin'),hex(parts['app0'][0]),str(build/'firmware.bin')],check=True)
factory=(fw/'posbox-latest.bin').read_bytes();assert factory[0x20000:]==app
(fw/'ric-ota.bin').write_bytes(app)
meta=json.loads((fw/'manifest.json').read_text());meta.update(version=version,bytes=len(factory),sha256=hashlib.sha256(factory).hexdigest(),partitionLayout='ric-ab-v1',ota={'bytes':len(app),'sha256':hashlib.sha256(app).hexdigest()})
(fw/'manifest.json').write_text(json.dumps(meta,indent=2)+'\n')
(fw/'ric-version.json').write_text(json.dumps({'version':version},indent=2)+'\n')
print(json.dumps({'version':version,'factoryBytes':len(factory),'otaBytes':len(app),'otaSha256':meta['ota']['sha256'],'otadata':hex(parts['otadata'][0])}))
