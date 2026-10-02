/**
 * Saved wallet connections: what a connection kind can do, and how it is
 * named. Kinds are open-ended on purpose - future integrations (for example
 * CLINK nDebit / nOffer strings from lightning.pub, which split send and
 * receive into separate pointers) become new kinds with their own capability
 * entry here, without touching the resolution code in walletSource.ts.
 */
export type ConnectionCapabilities = { send: boolean; receive: boolean };

/**
 * Capabilities by connection kind. Unknown kinds are inert until given an
 * entry here: connecting a wallet is not a claim that it can move money.
 */
export function connectionCapabilities(kind: string): ConnectionCapabilities {
  switch (kind) {
    case "nwc":
      return { send: true, receive: true };
    case "blink":
      return { send: true, receive: true };
    case "lnaddress":
      return { send: false, receive: true };
    default:
      return { send: false, receive: false };
  }
}

export function connectionKindLabel(kind: string): string {
  switch (kind) {
    case "nwc":
      return "Nostr Wallet Connect";
    case "blink":
      return "Blink";
    case "lnaddress":
      return "Lightning Address";
    default:
      return "Wallet";
  }
}

export function connectionDisplayLabel(kind: string, label: string | null | undefined): string {
  return label && label.trim() ? label.trim() : connectionKindLabel(kind);
}

/** Auto label for a new connection: kind name, numbered when repeats exist. */
export function nextConnectionLabel(existing: { kind: string }[], kind: string): string {
  const base = connectionKindLabel(kind);
  const sameKind = existing.filter((c) => c.kind === kind).length;
  return sameKind === 0 ? base : `${base} ${sameKind + 1}`;
}

/**
 * Provider names, keyed off hosts a wallet itself declares (NWC `lud16`,
 * NWC relay host, Lightning Address domain). Heuristics only - a miss is
 * fine: the connection keeps its generic kind name and stays renameable.
 */
const PROVIDER_HOSTS: [RegExp, string][] = [
  [/coinos/i, "Coinos"],
  [/blink\.sv|blink\.com/i, "Blink"],
  [/walletofsatoshi|wos\./i, "Wallet of Satoshi"],
  [/getalby\.com|alby/i, "Alby"],
  [/primal/i, "Primal"],
  [/minibits/i, "Minibits"],
  [/lnbits/i, "LNbits"],
  [/rizful/i, "Rizful"],
  [/zeusln|zeus/i, "Zeus"],
  [/getflash\.io|flashapp/i, "Flash"],
  [/buho/i, "Buho"],
];

export function providerFromHost(host: string | null | undefined): string | null {
  if (!host) return null;
  for (const [re, name] of PROVIDER_HOSTS) if (re.test(host)) return name;
  return null;
}

/** Best name for a connection, from what its own string declares. */
export function deriveConnectionLabel(kind: string, raw: string | null | undefined): string {
  const generic = connectionKindLabel(kind);
  if (!raw) return generic;
  if (kind === "nwc") {
    try {
      const u = new URL(raw);
      const lud16 = u.searchParams.get("lud16") ?? "";
      const lud16Host = lud16.includes("@") ? lud16.split("@").pop() ?? "" : "";
      let provider = providerFromHost(lud16Host);
      if (!provider) {
        for (const relay of u.searchParams.getAll("relay")) {
          try { provider = providerFromHost(new URL(relay).hostname); } catch { /* non-URL relay - skip */ }
          if (provider) break;
        }
      }
      return provider ? `${provider} NWC` : generic;
    } catch { return generic; }
  }
  if (kind === "lnaddress") {
    const host = raw.includes("@") ? raw.split("@").pop() ?? "" : "";
    return providerFromHost(host) ?? generic;
  }
  return generic;
}

/** First free name among existing rows: "Coinos NWC", then "Coinos NWC 2", ... */
export function uniqueConnectionLabel(existing: { kind: string; label: string | null }[], base: string): string {
  const used = new Set(existing.map((c) => connectionDisplayLabel(c.kind, c.label)));
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return base;
}

/** Safe API view of a connection row: never carries secrets. */
export function connectionPublicView(row: {
  id: string;
  kind: string;
  label: string | null;
  lightningAddress: string | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    kind: row.kind,
    label: connectionDisplayLabel(row.kind, row.label),
    capabilities: connectionCapabilities(row.kind),
    address: row.kind === "lnaddress" ? row.lightningAddress : null,
    createdAt: row.createdAt,
  };
}
