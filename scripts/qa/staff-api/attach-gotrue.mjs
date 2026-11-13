// Attach a disposable GoTrue to an iso-qa stack, mirroring scripts/qa/tw4f/run-chain.mjs --auth. Local containers only.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.MSYS_NO_PATHCONV = "1";
const [instance, port, jwt] = process.argv.slice(2);
if (!instance || !port || !jwt) throw new Error("usage: attach-gotrue.mjs <instance> <kong port> <jwt secret>");
const db = `df-isoqa-${instance}-db`;
const rest = `df-isoqa-${instance}-rest`;
const kong = `df-isoqa-${instance}-kong`;
const auth = `df-isoqa-${instance}-auth`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const psql = (sql) => execFileSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", db, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q"], { input: sql, encoding: "utf8" });

// GoTrue's own migrations must own the auth schema objects (disposable database only).
psql(`alter role supabase_auth_admin with password 'postgres';
do $q$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p where p.pronamespace = 'auth'::regnamespace and p.proowner <> 'supabase_auth_admin'::regrole loop execute format('alter function %s owner to supabase_auth_admin', r.sig); end loop;
  for r in select c.oid::regclass as rel, c.relkind from pg_class c where c.relnamespace = 'auth'::regnamespace and c.relkind in ('r','p','v','m','S') and c.relowner <> 'supabase_auth_admin'::regrole loop
    execute format('alter %s %s owner to supabase_auth_admin', case r.relkind when 'S' then 'sequence' when 'v' then 'view' when 'm' then 'materialized view' else 'table' end, r.rel); end loop;
  for r in select t.oid::regtype as ty from pg_type t where t.typnamespace = 'auth'::regnamespace and t.typtype = 'e' and t.typowner <> 'supabase_auth_admin'::regrole loop execute format('alter type %s owner to supabase_auth_admin', r.ty); end loop;
end $q$;`);

const network = docker("inspect", db, "--format", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}");
const e = (k, v) => ["-e", `${k}=${v}`];
docker("run", "-d", "--name", auth, "--label", "df.isoqa=1", "--label", "df.staffapi.qa=1", "--network", network, "--memory", "256m", "--cpus", "0.5",
  ...e("GOTRUE_API_HOST", "0.0.0.0"), ...e("GOTRUE_API_PORT", "9999"), ...e("API_EXTERNAL_URL", `http://127.0.0.1:${port}`), ...e("GOTRUE_DB_DRIVER", "postgres"), ...e("GOTRUE_DB_NAMESPACE", "auth"),
  ...e("GOTRUE_DB_DATABASE_URL", `postgres://supabase_auth_admin:postgres@${db}:5432/postgres`), ...e("GOTRUE_SITE_URL", "http://127.0.0.1:3000"), ...e("GOTRUE_JWT_SECRET", jwt), ...e("GOTRUE_JWT_EXP", "3600"),
  ...e("GOTRUE_JWT_AUD", "authenticated"), ...e("GOTRUE_JWT_DEFAULT_GROUP_NAME", "authenticated"), ...e("GOTRUE_DISABLE_SIGNUP", "false"), ...e("GOTRUE_EXTERNAL_EMAIL_ENABLED", "true"), ...e("GOTRUE_MAILER_AUTOCONFIRM", "true"),
  ...e("GOTRUE_RATE_LIMIT_EMAIL_SENT", "1000"), ...e("GOTRUE_LOG_LEVEL", "info"), "public.ecr.aws/supabase/gotrue:v2.188.1");

const yml = `_format_version: "2.1"
services:
  - name: rest-v1
    url: http://${rest}:3000/
    routes:
      - name: rest-v1
        strip_path: true
        paths: ["/rest/v1/"]
  - name: auth-v1
    url: http://${auth}:9999/
    routes:
      - name: auth-v1
        strip_path: true
        paths: ["/auth/v1/"]
`;
const ymlPath = path.join(os.tmpdir(), `kong-${instance}-auth.yml`);
writeFileSync(ymlPath, yml);
docker("cp", ymlPath, `${kong}:/home/kong/kong.yml`);
docker("restart", kong);

const deadline = Date.now() + 120_000;
for (;;) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/auth/v1/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) { console.log("gotrue healthy:", await res.text()); break; }
  } catch { /* not yet */ }
  if (Date.now() > deadline) { console.log(docker("logs", "--tail", "30", auth)); throw new Error("GoTrue did not come up"); }
  await new Promise((r) => setTimeout(r, 2000));
}
