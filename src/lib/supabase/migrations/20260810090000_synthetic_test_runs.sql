-- Production Synthetic Testing Harness -- audit model.
--
-- Governance source: FlowOps (C:\Dev\flowops) quality/PRODUCTION-SYNTHETIC-TESTING.md,
-- quality/SYNTHETIC-TEST-CATALOG.md, quality/RELEASE-VERIFICATION.md, and the
-- 2026-08-10 production-testing-authorization decision record. Owners: Ethan
-- Brooks (technical), Daniel Hayes (quality/release), Maya Reed (security).
--
-- One row per synthetic test EXECUTION (not per run -- a run may exercise
-- multiple tests across one or more suites; each test within a run gets its
-- own row sharing the same synthetic_run_id). This matches Daniel's required
-- result-field set in SYNTHETIC-TEST-CATALOG.md ("Required result fields")
-- and the evidence set in RELEASE-VERIFICATION.md ("Evidence required to
-- mark release verified").
--
-- This table is intentionally self-contained: it does not add columns or
-- flags to any existing production table (clients, appointments,
-- client_packages, event_registrations, payments, etc). Safety and cleanup
-- scoping are enforced entirely through (a) the synthetic tenant boundary
-- (synthetic_studio_id) and (b) created_record_refs recorded here, per
-- PRODUCTION-SYNTHETIC-TESTING.md safety requirement #2: "Cleanup may only
-- touch records created by the current synthetic run or explicitly tagged
-- synthetic fixtures."

create table if not exists "public"."synthetic_test_runs" (
  "id" uuid primary key default gen_random_uuid(),

  -- Shared by every test-row belonging to the same execution.
  "synthetic_run_id" text not null,

  -- Deployment identity captured at run time (Ethan's requirement --
  -- "deployment-SHA capture"). version is a human label (e.g. package.json
  -- version or a Vercel deployment id) when available; sha is the git
  -- commit. NOT NULL deliberately: this is meant to be a guarantee, not a
  -- best-effort convention, so the DB refuses a row with no deployment
  -- identity rather than silently accepting one. The application layer
  -- (src/lib/synthetic/deployment.ts getDeploymentInfo) always resolves
  -- at least the literal string "unknown" when no real SHA is available,
  -- so this never rejects a legitimate run.
  "deployment_sha" text not null,
  "deployment_version" text,
  "environment" text not null,

  -- Which synthetic tenant this execution ran against. Enforced NOT NULL so
  -- a row can never be created without recording the tenant boundary that
  -- was supposed to contain it -- this column is the audit-side half of the
  -- fail-closed guard implemented in src/lib/synthetic/guards.ts.
  "synthetic_studio_id" uuid not null,

  -- Catalog identity (SYNTHETIC-TEST-CATALOG.md): suite is the domain
  -- ("auth", "client", "schedule", "entitlement", "events", "payments-read"),
  -- test_id is the catalog id ("SYN-AUTH-001", etc).
  "suite" text not null,
  "test_id" text not null,

  "started_at" timestamp with time zone not null default now(),
  "completed_at" timestamp with time zone,

  "status" text not null default 'running',

  -- Safe (non-sensitive) failure classification -- never store raw
  -- exception messages that might contain PII, secrets, or full stack
  -- traces here. See src/lib/synthetic/types.ts SafeFailure.
  "safe_failure_code" text,
  "safe_failure_summary" text,

  -- { "clients": ["<uuid>"], "appointments": ["<uuid>"], ... } -- every
  -- record this test execution created, keyed by table name. This is what
  -- cleanup.ts reads to know exactly what it is allowed to touch.
  "created_record_refs" jsonb not null default '{}'::jsonb,

  "cleanup_status" text not null default 'not_required',
  "cleanup_error" text,

  -- How this execution was started. Phase 1 is manual-trigger only
  -- (PRODUCTION-SYNTHETIC-TESTING.md: "Manual trigger only at launch").
  "triggered_by" text not null default 'manual',
  "triggered_by_actor" text,

  "created_at" timestamp with time zone not null default now(),

  constraint "synthetic_test_runs_status_check"
    check ("status" in ('running', 'passed', 'failed', 'error')),
  constraint "synthetic_test_runs_cleanup_status_check"
    check ("cleanup_status" in ('not_required', 'pending', 'completed', 'failed', 'partial')),
  constraint "synthetic_test_runs_triggered_by_check"
    check ("triggered_by" in ('manual', 'cli', 'internal_route'))
);

comment on table "public"."synthetic_test_runs" is
  'Audit trail for the Production Synthetic Testing harness (FlowOps-governed). One row per test execution. Never contains customer data -- only references to synthetic-tenant-scoped records this harness itself created.';

create index if not exists "synthetic_test_runs_run_id_idx"
  on "public"."synthetic_test_runs" ("synthetic_run_id");

create index if not exists "synthetic_test_runs_studio_id_idx"
  on "public"."synthetic_test_runs" ("synthetic_studio_id");

create index if not exists "synthetic_test_runs_suite_test_idx"
  on "public"."synthetic_test_runs" ("suite", "test_id", "started_at" desc);

create index if not exists "synthetic_test_runs_status_idx"
  on "public"."synthetic_test_runs" ("status")
  where "status" in ('running', 'failed', 'error');

-- RLS: this table is written only by the harness's own server-side runner
-- (service-role client -- see src/lib/synthetic/audit.ts and the note in
-- PRODUCTION-SYNTHETIC-TESTING.md safety requirement #4 about service-role
-- boundaries requiring Maya's approval). It is never written by the
-- synthetic *browser/business-flow* identities themselves, and never
-- exposed to any client-facing route. Enable RLS with no policies so that
-- even if a future code path accidentally uses a non-admin client against
-- this table, access is denied by default rather than open.
alter table "public"."synthetic_test_runs" enable row level security;

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- This migration is purely additive (one new, self-contained table; no
-- existing table is altered) and has no dependents, so rollback is a single
-- statement. Not run as part of this migration -- kept here as the explicit,
-- confirmed rollback path Daniel's release-verification review requires on
-- file, to be executed manually and separately if this table needs to be
-- removed:
--
--   drop table if exists "public"."synthetic_test_runs";
