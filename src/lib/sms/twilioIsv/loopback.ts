/**
 * The ONE definition of "this host is the local machine" for the TW-4 safety checks (the fake adapter's database check, the validation stage
 * guards, the network fence and the harness's local-stack check). Pure and dependency-free so scripts can import it before anything else.
 * `URL.hostname` reports IPv6 loopback as "[::1]".
 */
export const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.includes(hostname);
}

/** True only for a parseable URL whose hostname is exactly a loopback host (no subdomain or userinfo tricks: they change `hostname`). */
export function isLoopbackUrl(rawUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}
