// The runner process itself makes one HTTPS request (the branch tip) and spawns git and the proof. A same-user agent can set process-wide variables that
// redirect, observe or patch that traffic or inject code (proxy, CA, TLS verification, NODE_OPTIONS). A live run refuses to start if any is present. The list
// is the proof's own environment check (identity.ts checkEnvironment) plus every *_PROXY / NODE_TLS_* variable and the node flags that do the same.

import { checkEnvironment } from "../d24-m3d-proof/identity";

const RISKY_FLAGS = /^--(use-env-proxy|use-system-ca|use-openssl-ca|openssl-config|tls-)/;

export function processEnvProblems(env: Record<string, string | undefined>, execArgv: readonly string[] = []): string[] {
  const problems = checkEnvironment(env);
  for (const [name, v] of Object.entries(env)) {
    if (!v) continue;
    if ((/_PROXY$/i.test(name) || /^NODE_TLS_/i.test(name)) && !problems.some((p) => p.startsWith(`${name} `))) problems.push(`${name} is set (process-wide proxy / TLS setting: it can redirect or weaken the runner's own HTTPS request)`);
  }
  for (const a of execArgv) if (RISKY_FLAGS.test(a)) problems.push(`node was started with ${a} (it changes proxy / CA / TLS behaviour of the runner's own HTTPS request)`);
  return problems;
}
