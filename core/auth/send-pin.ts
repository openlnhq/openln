import bcrypt from "bcryptjs";

/**
 * Merchant SEND PIN: 6 digits, authorizes sats leaving via the RIC
 * (POST /api/pos/withdraw, POST /api/pos/send-to-card). Stored bcrypt-hashed
 * in entities.pin_hash, ported verbatim from bitPOS pos.ts.
 *
 * This is NOT the 4-digit Card PIN in core/auth/card-pin.ts, which customers
 * enter to SPEND from a Bolt Card and which is stored per-card in
 * cards.pin_hash (bcrypt legacy / scrypt native). The two must never be
 * mixed: different length, different secret, different tables, different
 * holders.
 *
 * accounts.register() writes the literal "password-login" as a placeholder
 * (never a bcrypt hash): that means no send PIN has been set yet.
 */
export const SEND_PIN_UNSET = "password-login";

/** Shape validation for SETTING a PIN: openLN requires 6 digits. */
export function validSendPinFormat(pin: string): boolean {
  return /^\d{6}$/.test(pin);
}

/**
 * Verification accepts legacy 4-digit pins too: bitPOS accounts predating the
 * 6-digit upgrade (accounts.pin_upgraded = false) hold bcrypt hashes of 4-digit
 * PINs and must keep working on the device send path untouched.
 */
function plausibleSendPin(pin: string): boolean {
  return /^\d{4,6}$/.test(pin);
}

export async function verifySendPin(pin: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored || stored === SEND_PIN_UNSET || !plausibleSendPin(pin)) return false;
  try {
    return await bcrypt.compare(pin, stored);
  } catch {
    return false;
  }
}

/** bcrypt hashes only: matches bitPOS pos.ts device sends and migrated legacy accounts. */
export async function hashSendPin(pin: string): Promise<string> {
  if (!validSendPinFormat(pin)) throw Error("Send PIN must be exactly 6 digits");
  return await bcrypt.hash(pin, 10);
}
