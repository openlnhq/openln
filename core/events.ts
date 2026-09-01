type Listener = (event: string, data: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
export function onAccountEvent(accountId: string, listener: Listener): () => void {
  let set = listeners.get(accountId);
  if (!set) { set = new Set(); listeners.set(accountId, set); }
  set.add(listener);
  return () => { set?.delete(listener); if (set?.size === 0) listeners.delete(accountId); };
}
export function emitAccountEvent(accountId: string, event: string, data: unknown = {}): void {
  for (const listener of listeners.get(accountId) ?? []) {
    try { listener(event, data); } catch { /* listener isolation */ }
  }
}
