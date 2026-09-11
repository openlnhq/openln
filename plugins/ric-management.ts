import type {IncomingMessage, ServerResponse} from "node:http";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {and, eq, isNull} from "drizzle-orm";
import {db, deviceTokensTable, ricDeviceTelemetryTable} from "../core/db/index.js";
import {z} from "zod";
import {DOMAIN} from "../core/domain.js";

/** authType is trusted server-side evidence, never a request/body field. */
export interface RicAccount {id: string; authType?: "session" | "device"}
export interface RicFirmware {
  version: string;
  url: string;
  sha256: string;
  bytes: number;
  board: "esp32-2432s028r";
  partitionLayout: "ric-ab-v1";
}
const BOARD = "esp32-2432s028r";
const LAYOUT = "ric-ab-v1";
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Read one release snapshot. Never advertise a hash/size for unverified bytes. */
export async function readRicRelease(directory = join(process.cwd(), "firmware")): Promise<{firmware: RicFirmware; image: Buffer}> {
  const [manifestRaw, versionRaw, factory, image] = await Promise.all([
    readFile(join(directory, "manifest.json"), "utf8"),
    readFile(join(directory, "ric-version.json"), "utf8"),
    readFile(join(directory, "posbox-latest.bin")),
    readFile(join(directory, "ric-ota.bin")),
  ]);
  const manifest = JSON.parse(manifestRaw);
  const meta = JSON.parse(versionRaw);
  if (manifest.board !== BOARD || manifest.chip !== "ESP32" || manifest.kind !== "factory" || manifest.address !== 0 ||
      manifest.bytes !== factory.length || manifest.sha256 !== hash(factory) ||
      typeof meta.version !== "string" || !/^\d+\.\d+\.\d+$/.test(meta.version) || manifest.version !== meta.version) {
    throw Error("Invalid RIC release manifest");
  }
  const slots = new Map<string, {type: number; subtype: number; offset: number; size: number}>();
  for (let p = 0x8000; p + 32 <= Math.min(factory.length, 0x9000); p += 32) {
    if (factory.readUInt16LE(p) !== 0x50aa) break;
    const label = factory.subarray(p + 12, p + 28).toString("ascii").split("\0")[0];
    slots.set(label, {type: factory[p + 2], subtype: factory[p + 3], offset: factory.readUInt32LE(p + 4), size: factory.readUInt32LE(p + 8)});
  }
  const expected = [
    ["nvs", 1, 2, 0x10000, 0x6000], ["otadata", 1, 0, 0x16000, 0x2000],
    ["app0", 0, 0x10, 0x20000, 0x1e0000], ["app1", 0, 0x11, 0x200000, 0x1e0000],
  ] as const;
  for (const [name, type, subtype, offset, size] of expected) {
    const slot = slots.get(name);
    if (!slot || slot.type !== type || slot.subtype !== subtype || slot.offset !== offset || slot.size !== size) throw Error("Invalid RIC partition layout");
  }
  if (image.length < 24 || image.length > 0x1e0000 || image[0] !== 0xe9 || image.readUInt16LE(12) !== 0 ||
      !factory.subarray(0x20000).equals(image) || !image.includes(Buffer.from(meta.version + "\0"))) throw Error("Invalid RIC application image");
  const sha256 = hash(image);
  const origin = new URL(`https://${DOMAIN}`);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw Error("Invalid RIC firmware origin");
  // Preserve these first two fields for the deployed manual JSON parser.
  const firmware: RicFirmware = {version: meta.version, url: `${origin.origin}/api/firmware/ric/${sha256}.bin`, sha256, bytes: image.length, board: BOARD, partitionLayout: LAYOUT};
  return {firmware, image};
}

function json(req: IncomingMessage, res: ServerResponse, status: number, value: unknown): true {
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {"Content-Type": "application/json", "Content-Length": data.length,
    "Cache-Control": "no-store, no-transform", "Connection": "close", "X-Content-Type-Options": "nosniff"});
  res.end(req.method === "HEAD" ? undefined : data);
  return true;
}
function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}
async function deviceIdentity(req: IncomingMessage) {
  const raw = bearer(req);
  if (!raw || !/^[0-9a-f]{64}$/.test(raw)) return undefined;
  const [device] = await db.select({id: deviceTokensTable.id, accountId: deviceTokensTable.accountId})
    .from(deviceTokensTable).where(and(eq(deviceTokensTable.token, raw), isNull(deviceTokensTable.revokedAt))).limit(1);
  return device;
}

/** Wire before handlePosboxRoute to replace only the existing OTA branches. */
export async function handleRicFirmwareRoute(req: IncomingMessage, res: ServerResponse, u: URL, account?: RicAccount): Promise<boolean> {
  const version = u.pathname === "/api/firmware/posbox-version";
  const legacyBin = u.pathname === "/api/firmware/posbox-ota.bin";
  const immutable = u.pathname.match(/^\/api\/firmware\/ric\/([0-9a-f]{64})\.bin$/);
  if (!version && !legacyBin && !immutable) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return json(req, res, 405, {error: "Method not allowed"});
  if (version && !account && !await deviceIdentity(req)) return json(req, res, 401, {error: "Authentication required"});
  let release: Awaited<ReturnType<typeof readRicRelease>>;
  try { release = await readRicRelease(); }
  catch { return json(req, res, 503, {error: "Firmware release unavailable"}); }
  if (version) return json(req, res, 200, release.firmware);
  if (immutable && immutable[1] !== release.firmware.sha256) return json(req, res, 404, {error: "Firmware image not found"});
  res.writeHead(200, {"Content-Type": "application/octet-stream", "Content-Length": release.image.length,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable, no-transform" : "no-store, no-transform",
    "ETag": `"${release.firmware.sha256}"`, "Connection": "close", "X-Content-Type-Options": "nosniff"});
  res.end(req.method === "HEAD" ? undefined : release.image);
  return true;
}

const versionField = z.string().max(32).regex(/^\d+\.\d+\.\d+$/);
const telemetryFields = {
  firmwareVersion: versionField,
  board: z.literal(BOARD),
  mac: z.string().regex(/^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/),
  partitionLayout: z.literal(LAYOUT),
  bootId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  uptimeMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  runningPartition: z.string().max(16).regex(/^(?:app[01]|ota_[01]|factory)$/).optional(),
  ota: z.object({
    state: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/),
    code: z.union([z.number().int().min(-2147483648).max(2147483647), z.string().max(64).regex(/^[a-zA-Z0-9_.:-]*$/)]).optional(),
    targetVersion: versionField.optional(),
  }).strict().optional(),
};
const helloSchema = z.object(telemetryFields).strict();
const statusSchema = helloSchema.partial().strict();

async function readTelemetry(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4096) throw Error("Invalid telemetry");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Parent supplies {id, authType:'session'} only after verifying browser auth.
 * Device POSTs revalidate the exact raw Bearer token, irrespective of account.
 * deviceId is device_tokens.id, not the separate partner/MAC attribution row.
 */
export async function handleRicManagementRoute(req: IncomingMessage, res: ServerResponse, u: URL, account?: RicAccount): Promise<boolean> {
  if (await handleRicFirmwareRoute(req, res, u, account)) return true;
  const hello = u.pathname === "/api/ric/hello";
  const status = u.pathname === "/api/ric/status";
  const list = u.pathname === "/api/ric/devices";
  if (!hello && !status && !list) return false;
  if (list) {
    if (req.method !== "GET") return json(req, res, 405, {error: "Method not allowed"});
    if (!account || account.authType !== "session" || /^[0-9a-f]{64}$/.test(bearer(req) ?? "")) {
      return json(req, res, 403, {error: "Browser session required"});
    }
    const rows = await db.select({
      deviceId: deviceTokensTable.id, label: deviceTokensTable.label, createdAt: deviceTokensTable.createdAt,
      revokedAt: deviceTokensTable.revokedAt, lastUsedAt: deviceTokensTable.lastUsedAt,
      firmwareVersion: ricDeviceTelemetryTable.firmwareVersion, board: ricDeviceTelemetryTable.board,
      mac: ricDeviceTelemetryTable.mac, partitionLayout: ricDeviceTelemetryTable.partitionLayout,
      bootId: ricDeviceTelemetryTable.bootId, uptimeMs: ricDeviceTelemetryTable.uptimeMs,
      runningPartition: ricDeviceTelemetryTable.runningPartition,
      lastSeenAt: ricDeviceTelemetryTable.lastSeenAt, lastHelloAt: ricDeviceTelemetryTable.lastHelloAt,
      otaState: ricDeviceTelemetryTable.otaState, otaCode: ricDeviceTelemetryTable.otaCode,
      otaTargetVersion: ricDeviceTelemetryTable.otaTargetVersion,
    }).from(deviceTokensTable).leftJoin(ricDeviceTelemetryTable, eq(ricDeviceTelemetryTable.deviceTokenId, deviceTokensTable.id))
      .where(eq(deviceTokensTable.accountId, account.id)).orderBy(deviceTokensTable.createdAt, deviceTokensTable.id);
    return json(req, res, 200, {devices: rows.map(({otaState, otaCode, otaTargetVersion, ...row}) => ({
      ...row, ota: otaState === null ? null : {state: otaState, code: otaCode, targetVersion: otaTargetVersion},
    }))});
  }
  if (req.method !== "POST") return json(req, res, 405, {error: "Method not allowed"});
  const identity = await deviceIdentity(req);
  if (!identity) return json(req, res, 401, {error: "Device authentication required"});
  let parsed: z.infer<typeof statusSchema>;
  try { parsed = (hello ? helloSchema : statusSchema).parse(await readTelemetry(req)); }
  catch { return json(req, res, 400, {error: "Invalid device telemetry"}); }
  const now = new Date();
  const values: typeof ricDeviceTelemetryTable.$inferInsert = {
    deviceTokenId: identity.id, lastSeenAt: now, ...(hello ? {lastHelloAt: now} : {}),
    firmwareVersion: parsed.firmwareVersion, board: parsed.board, mac: parsed.mac,
    partitionLayout: parsed.partitionLayout, bootId: parsed.bootId, uptimeMs: parsed.uptimeMs,
    runningPartition: parsed.runningPartition,
    // No ota field means preserve the latest reported state. A new state clears a stale code.
    ...(parsed.ota ? {otaState: parsed.ota.state, otaCode: parsed.ota.code === undefined ? null : String(parsed.ota.code),
      otaTargetVersion: parsed.ota.targetVersion ?? null} : {}),
  };
  const accepted = await db.transaction(async tx => {
    // Lock/check revocation at the write boundary, not just before parsing the body.
    const [active] = await tx.select({id: deviceTokensTable.id}).from(deviceTokensTable)
      .where(and(eq(deviceTokensTable.id, identity.id), isNull(deviceTokensTable.revokedAt))).for("update");
    if (!active) return false;
    await tx.insert(ricDeviceTelemetryTable).values(values).onConflictDoUpdate({target: ricDeviceTelemetryTable.deviceTokenId, set: values});
    await tx.update(deviceTokensTable).set({lastUsedAt: now}).where(eq(deviceTokensTable.id, identity.id));
    return true;
  });
  if (!accepted) return json(req, res, 401, {error: "Device authentication required"});
  return json(req, res, 200, {status: "ok", deviceId: identity.id, accountId: identity.accountId});
}
