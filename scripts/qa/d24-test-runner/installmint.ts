// The ONLY place the "verified installed root" brand can be minted. Only execinbox.ts may import markVerifiedInstalled (a static import-scan test in
// installer.test.ts keeps it so): tests and other tooling obtain a branded object only by passing every execinbox gate. The brand is an in-process
// invariant, not a security boundary by itself: what keeps the key from the owner's user is that the key is unreadable to that user (d24run custody).

const verified = new WeakSet<object>();
export const verifiedInstalledSet: { has(o: object): boolean } = { has: (o) => verified.has(o) };
export function markVerifiedInstalled<T extends object>(i: T): T {
  verified.add(i);
  return i;
}
