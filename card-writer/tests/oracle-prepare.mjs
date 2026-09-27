/**
 * Oracle preparation: transform the production lawalletio card-installer
 * ES module so it can run in Node against the mock card.
 *
 * The module is vendored under tests/oracle/vendor (MIT) for offline runs;
 * falls back to /root/refs/card-installer when present. Only import
 * specifiers are rewritten; all crypto/flow logic stays untouched.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ORACLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "oracle");
const VENDORED = join(ORACLE_DIR, "vendor", "Ntag424.js");
const REFS = "/root/refs/card-installer/src/class/Ntag424.js";
const SRC = existsSync(VENDORED) ? VENDORED : REFS;

export function prepareOracle() {
  let code = readFileSync(SRC, "utf8");
  const reps = [
    ["from 'react-native-nfc-manager'", "from './nfc-shim.mjs'"],
    ["import {randomBytes} from 'crypto';", "import { randomBytes } from './det-random.mjs';"],
    ["from '../constants/ErrorCodes'", "from './errorcodes-shim.mjs'"],
    ["var CryptoJS = require('../utils/Cmac');", "import CryptoJS from './Cmac.cjs';"],
    ["var AES = require('crypto-js/aes');", "import AES from 'crypto-js/aes.js';"],
  ];
  for (const [from, to] of reps) {
    if (!code.includes(from)) throw new Error(`oracle transform: pattern missing: ${from}`);
    code = code.replace(from, to);
  }
  if (!/export default/.test(code)) code += "\nexport default Ntag424;\n";
  const dest = join(ORACLE_DIR, "lawalletio-ntag424.mjs");
  writeFileSync(dest, code);
  return dest;
}
