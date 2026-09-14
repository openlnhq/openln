// Compile real vendor methods, with optional RIC_NFC_LIBRARY for upstream repro.
// Never edits .pio or the library. Run from the repository root.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const library = resolve(process.env.RIC_NFC_LIBRARY || 'firmware/esp32-pos/lib/Adafruit-PN532-NTAG424');
const sourcePath = join(library, 'Adafruit_PN532_NTAG424.cpp');
const source = readFileSync(sourcePath, 'utf8');
const header = readFileSync(join(library, 'Adafruit_PN532_NTAG424.h'), 'utf8');
const methods = ['setPassiveActivationRetries', 'readDetectedPassiveTargetID', 'ntag424_ISOReadFile',
  'inDataExchange', 'readdata'];
const constants = ['PN532_COMMAND_RFCONFIGURATION', 'PN532_COMMAND_INDATAEXCHANGE',
  'NTAG424_COM_CLA', 'NTAG424_CMD_GETFILESETTINGS', 'NTAG424_COM_ISOCLA',
  'NTAG424_CMD_ISOSELECTFILE', 'NTAG424_CMD_ISOREADBINARY', 'PN532_PACKBUFFSIZ',
  'PN532_PN532TOHOST', 'PN532_RESPONSE_INDATAEXCHANGE', 'PN532_SPI_DATAREAD', 'PN532_I2C_READY'];
const dir = mkdtempSync(join(tmpdir(), 'ric-nfc-library-'));
try {
  const helpers = [...source.matchAll(/^static bool pn532_[\s\S]*?^}/gm)].map(match => match[0]).join('\n');
  writeFileSync(join(dir, 'installed-methods.inc'), helpers + '\n' + methods.map(name => {
    const match = new RegExp(`^(?:bool|uint8_t|void) Adafruit_PN532::${name}\\([\\s\\S]*?^}`, 'm').exec(source);
    assert.ok(match, `installed method ${name} must be present, do not substitute a copy`);
    const line = source.slice(0, match.index).split('\n').length;
    return `#line ${line} ${JSON.stringify(sourcePath)}\n${match[0]}\n`;
  }).join('\n'));
  writeFileSync(join(dir, 'installed-constants.inc'), constants.map(name => {
    const match = new RegExp(`^#define ${name} .*`, 'm').exec(header + '\n' + source);
    assert.ok(match, `installed constant ${name} must exist`);
    return match[0];
  }).join('\n'));
  const exe = join(dir, 'probe');
  const build = spawnSync(process.env.CXX || 'g++', ['-std=c++17', '-Wall', '-Wextra',
    '-Wno-unused-but-set-variable', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-g',
    '-I' + dir, 'tests/ric-nfc-library-repro.cpp', '-o', exe], { encoding: 'utf8', timeout: 60000 });
  assert.equal(build.status, 0, build.error?.message || build.stdout + build.stderr);
  const cases = process.argv.length > 2 ? process.argv.slice(2) : [
    'finite-command', 'valid-ndef', 'nlen-zero', 'nlen-high-byte',
    'uid-destination-capacity', 'uid-library-source-capacity'];
  let failed = 0;
  for (const name of cases) {
    const result = spawnSync(exe, [name], { encoding: 'utf8', timeout: 15000,
      env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0:halt_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1' } });
    if (result.status !== 0) ++failed;
    const output = result.error?.message || result.stdout + result.stderr;
    console.log(`${result.status === 0 ? 'PASS' : 'FAIL'} ${name}: exit=${result.status}`);
    console.log(output.split('\n').slice(0, 12).join('\n'));
  }
  console.log(JSON.stringify({ library, probes: cases.length, failed }));
  process.exitCode = failed ? 1 : 0;
} finally { rmSync(dir, { recursive: true, force: true }); }
