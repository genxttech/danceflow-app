/**
 * A random UUID v4 for client-supplied entity ids (noteId, clientId). The server stores the row under this id, so a retry of the same user action
 * resends the same value (Staff_API_Contract.md "Write helpers"). Uses the platform's crypto when present; otherwise Math.random, which is enough here:
 * the id is an idempotency identity, not a secret, and a collision is refused by the server (same id with different content is 409 idempotency_conflict).
 */
export function newEntityId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const hex = (n: number) => Math.floor(Math.random() * n).toString(16);
  const bytes = Array.from({ length: 32 }, () => hex(16));
  bytes[12] = "4";
  bytes[16] = "89ab"[Math.floor(Math.random() * 4)];
  const s = bytes.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
