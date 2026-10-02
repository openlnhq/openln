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
