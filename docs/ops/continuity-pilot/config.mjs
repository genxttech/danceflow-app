// Trust anchor. These constants are the ONLY source of the protected remote; they are code, changed only through the
// CODEOWNERS-protected path /docs/ops/continuity-pilot/. The production CLI accepts no flag or env var to override them.
export const DEFAULT_SOURCE = {
  url: 'https://github.com/genxttech/danceflow-app/',
  ref: 'main',
  policyPath: 'docs/ops/continuity-pilot/phase2/policy.json',
  authPath: 'docs/ops/continuity-pilot/phase2/authorizations.json',
  credentialHelper: '!node C:/Users/mcurt/d24-app-key/git-credential-app.mjs',
};
