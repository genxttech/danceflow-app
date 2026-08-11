import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertDeploymentInfoIsProductionSafe,
  getDeploymentInfo,
  isTestExecutionContext,
} from "@/lib/synthetic/deployment";
import { SyntheticSafetyError } from "@/lib/synthetic/types";

const KEYS = [
  "SYNTHETIC_DEPLOYMENT_SHA",
  "SYNTHETIC_DEPLOYMENT_VERSION",
  "SYNTHETIC_ENVIRONMENT",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_ENV",
  "npm_package_version",
];

const TEST_CONTEXT_KEYS = ["VITEST", "NODE_ENV"];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("getDeploymentInfo", () => {
  it("falls back to explicit unknown values when nothing is set", () => {
    const info = getDeploymentInfo();
    expect(info.sha).toBe("unknown");
    expect(info.version).toBeNull();
    expect(info.environment).toBe("unknown");
  });

  it("prefers Vercel's own env vars when SYNTHETIC_* overrides are absent", () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abc123";
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_xyz";
    process.env.VERCEL_ENV = "production";
    const info = getDeploymentInfo();
    expect(info.sha).toBe("abc123");
    expect(info.version).toBe("dpl_xyz");
    expect(info.environment).toBe("production");
  });

  it("prefers explicit SYNTHETIC_* overrides over Vercel's env vars", () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abc123";
    process.env.VERCEL_ENV = "production";
    process.env.SYNTHETIC_DEPLOYMENT_SHA = "override-sha";
    process.env.SYNTHETIC_ENVIRONMENT = "staging";
    const info = getDeploymentInfo();
    expect(info.sha).toBe("override-sha");
    expect(info.environment).toBe("staging");
  });

  it("falls back to npm_package_version for version when nothing else is set", () => {
    process.env.npm_package_version = "0.1.0";
    const info = getDeploymentInfo();
    expect(info.version).toBe("0.1.0");
  });
});

describe("assertDeploymentInfoIsProductionSafe", () => {
  let savedTestContext: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedTestContext = {};
    for (const key of TEST_CONTEXT_KEYS) {
      savedTestContext[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of TEST_CONTEXT_KEYS) {
      if (savedTestContext[key] === undefined) delete process.env[key];
      else process.env[key] = savedTestContext[key];
    }
  });

  function simulateNonTestContext() {
    delete process.env.VITEST;
    // NODE_ENV is typed read-only by Next.js's ambient types; this is a
    // test-only simulation of a non-test process, not real app code.
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  }

  it("is a no-op for explicit SYNTHETIC_* overrides, even outside a test context", () => {
    simulateNonTestContext();
    process.env.SYNTHETIC_DEPLOYMENT_SHA = "override-sha";
    process.env.SYNTHETIC_ENVIRONMENT = "production";
    const info = getDeploymentInfo();

    expect(() => assertDeploymentInfoIsProductionSafe(info)).not.toThrow();
  });

  it("is a no-op for Vercel-derived metadata, even outside a test context", () => {
    simulateNonTestContext();
    process.env.VERCEL_GIT_COMMIT_SHA = "abc123";
    process.env.VERCEL_ENV = "production";
    const info = getDeploymentInfo();

    expect(() => assertDeploymentInfoIsProductionSafe(info)).not.toThrow();
  });

  it("throws SyntheticSafetyError when sha and environment are both unresolved outside a test context", () => {
    simulateNonTestContext();
    const info = getDeploymentInfo();

    expect(info.sha).toBe("unknown");
    expect(info.environment).toBe("unknown");
    expect(() => assertDeploymentInfoIsProductionSafe(info)).toThrow(SyntheticSafetyError);
    expect(() => assertDeploymentInfoIsProductionSafe(info)).toThrow(/deployment SHA and environment/);
  });

  it("throws when only the environment remains unresolved", () => {
    simulateNonTestContext();
    process.env.SYNTHETIC_DEPLOYMENT_SHA = "override-sha";
    const info = getDeploymentInfo();

    expect(() => assertDeploymentInfoIsProductionSafe(info)).toThrow(/environment/);
  });

  it("does not throw for unresolved metadata while running under Vitest (the actual current context)", () => {
    // No simulateNonTestContext() call here -- this proves the real,
    // un-mocked isTestExecutionContext() reads Vitest's own env vars.
    expect(isTestExecutionContext()).toBe(true);
    const info = getDeploymentInfo();

    expect(() => assertDeploymentInfoIsProductionSafe(info)).not.toThrow();
  });
});
