// Trust anchor. These constants are the ONLY source of the protected remote; they are code, changed only through the
// CODEOWNERS-protected path /docs/ops/continuity-pilot/. The production CLI accepts no flag or env var to override them.
export const DEFAULT_SOURCE = {
  url: 'https://github.com/genxttech/danceflow-app/',
  ref: 'refs/heads/main', // fully qualified: a tag named main must never shadow the protected branch
  policyPath: 'docs/ops/continuity-pilot/phase2/policy.json',
  authPath: 'docs/ops/continuity-pilot/phase2/authorizations.json',
  // The local code that runs the loop must byte-equal (modulo CRLF) the reviewed copy on the protected ref.
  codeDir: 'docs/ops/continuity-pilot',
  codeFiles: ['orchestrator.mjs', 'protected-source.mjs', 'config.mjs', 'deny-check.mjs', 'deny-probe.mjs', 'preflight.mjs', 'owner-tool.mjs', 'phase2/required-deny.json', 'phase2/scripts/run_u18s2.sh'],
  credentialHelper: '!node C:/Users/mcurt/d24-app-key/git-credential-app.mjs',
};
