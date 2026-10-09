import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EARNINGS_EMPTY,
  PAY_PERIOD_EMPTY,
  batchesEmptyMessage,
  earningIsEditable,
  earningLockNote,
  formatStudioDate,
  generationMessage,
  periodLockNote,
} from "../payrollStates";

/** Phase 9E: honest generation-cap copy, clear locked states, empty states with one next action. */

describe("generationMessage (500-item cap)", () => {
  const base = { scanned: 500, staged: 480, skipped: 20, attendanceFailed: 0 };
  it("says the run is incomplete and what to do when the cap was reached", () => {
    const message = generationMessage({ ...base, truncated: true });
    expect(message).toContain("Earnings review incomplete");
    expect(message).toContain("500 eligible");
    expect(message).toContain("more eligible items remain");
    expect(message).toContain("Narrow the date range");
  });
  it("reports a normal run as complete without a cap warning", () => {
    const message = generationMessage({ ...base, scanned: 12, staged: 12, skipped: 0, truncated: false });
    expect(message).toBe("Earnings review complete. Reviewed 12, staged 12, skipped 0.");
    expect(message).not.toContain("500");
  });
  it("still reports attendance failures, alone or with the cap", () => {
    expect(generationMessage({ ...base, attendanceFailed: 1, truncated: false })).toContain("1 class could not be staged");
    const both = generationMessage({ ...base, attendanceFailed: 2, truncated: true });
    expect(both).toContain("2 classes could not be staged");
    expect(both).toContain("Narrow the date range");
  });
});

describe("locked states", () => {
  it("explains and locks paid, void and batched earnings", () => {
    expect(earningLockNote({ status: "paid" })).toMatch(/Paid and locked/);
    expect(earningLockNote({ status: "void" })).toMatch(/Voided/);
    expect(earningLockNote({ status: "approved", payroll_batch_id: "b1" })).toMatch(/Locked in a payroll batch/);
    expect(earningLockNote({ status: "pending", payroll_batch_id: "b1" })).toMatch(/Locked in a payroll batch/);
    for (const earning of [{ status: "paid" }, { status: "void" }, { status: "approved", payroll_batch_id: "b1" }]) {
      expect(earningIsEditable(earning)).toBe(false);
    }
  });
  it("leaves unbatched pending and approved earnings editable with no lock note", () => {
    for (const status of ["pending", "approved"]) {
      expect(earningLockNote({ status, payroll_batch_id: null })).toBeNull();
      expect(earningIsEditable({ status })).toBe(true);
    }
  });
  it("explains closed pay periods and keeps open ones unlocked", () => {
    expect(periodLockNote("open")).toBeNull();
    expect(periodLockNote("in_review")).toBeNull();
    expect(periodLockNote("paid")).toMatch(/Paid and closed.*view/);
    expect(periodLockNote("closed")).toMatch(/can no longer receive earnings/);
    expect(periodLockNote("void")).toMatch(/Voided/);
    expect(periodLockNote("approved")).toMatch(/Closed/);
  });
});

describe("empty states", () => {
  it("gives each empty state one next action", () => {
    expect(PAY_PERIOD_EMPTY.actionHref).toBe("#create-pay-period");
    expect(EARNINGS_EMPTY.noInstructors.actionHref).toBe("/app/instructors");
    expect(EARNINGS_EMPTY.noEligible.actionHref).toBe("#generate-earnings");
    expect(EARNINGS_EMPTY.noRules.actionLabel).toMatch(/compensation/i);
  });
  it("tailors the no-batches message to whether the period is open", () => {
    expect(batchesEmptyMessage("open")).toMatch(/create a batch/);
    expect(batchesEmptyMessage("paid")).not.toMatch(/create a batch/);
  });
});

describe("page wiring", () => {
  const root = path.resolve(__dirname, "..");
  const page = readFileSync(path.join(root, "page.tsx"), "utf8");
  const periodPage = readFileSync(path.join(root, "periods/[id]/page.tsx"), "utf8");

  it("renders the generation result through the shared cap message", () => {
    expect(page).toMatch(/generationMessage\(/);
  });
  it("renders empty-state actions", () => {
    expect(page).toMatch(/PAY_PERIOD_EMPTY\.actionHref/);
    expect(page).toMatch(/EARNINGS_EMPTY\.noInstructors\.actionHref/);
    expect(page).toMatch(/EARNINGS_EMPTY\.noEligible\.actionHref/);
    expect(page).toMatch(/EARNINGS_EMPTY\.noRules\.actionLabel/);
    expect(page).toMatch(/id="create-pay-period"/);
    expect(page).toMatch(/id="generate-earnings"/);
  });
  it("shows the lock notes and keeps edit actions gated on the same lock rule", () => {
    expect(page).toMatch(/earningLockNote\(earning\)/);
    expect(page).toMatch(/\{periodLockNote\(period\.status\) \? <p/);
    expect(periodPage).toMatch(/periodLockNote\(period\.status\)/);
    expect(page).toMatch(/\{!earning\.payroll_batch_id && earning\.status !== "paid" && earning\.status !== "void" \? \(\s*<form action=\{overrideInstructorEarningAction\}/);
    expect(page).toMatch(/\{!earning\.payroll_batch_id && earning\.status === "pending" \? \(\s*<form action=\{updateInstructorEarningStatusAction\}/);
    expect(page).toMatch(/\["open", "in_review"\]\.includes\(period\.status\)/);
  });
  it("stacks the pay-period and generation forms before wide breakpoints", () => {
    expect(page).toMatch(/id="create-pay-period"[^>]*sm:grid-cols-3 xl:grid-cols-\[/);
    expect(page).toMatch(/sm:grid-cols-\[150px_150px_auto\]/);
    expect(page).toMatch(/action=\{createPayrollBatchAction\} className="flex flex-wrap gap-2"/);
  });
  it("tells the user the generation cap and local-date basis before they run it", () => {
    expect(page).toMatch(/up to the 500 most recent eligible items/);
    expect(page).toMatch(/studio&apos;s local time/);
  });
});

describe("Paid date is shown in the studio time zone", () => {
  // 2026-10-10 02:30 UTC is still Oct 9 in New York and already Oct 10 in Tokyo.
  const paidAt = "2026-10-10T02:30:00Z";
  it("shows the studio-local calendar day for the same stored instant", () => {
    expect(formatStudioDate(paidAt, "America/New_York")).toBe("Oct 9, 2026");
    expect(formatStudioDate(paidAt, "America/Los_Angeles")).toBe("Oct 9, 2026");
    expect(formatStudioDate(paidAt, "Asia/Tokyo")).toBe("Oct 10, 2026");
    expect(formatStudioDate(paidAt, "Pacific/Auckland")).toBe("Oct 10, 2026");
  });
  it("handles a DST boundary day", () => {
    expect(formatStudioDate("2026-11-01T04:30:00Z", "America/New_York")).toBe("Nov 1, 2026");
    expect(formatStudioDate("2026-11-01T03:30:00Z", "America/New_York")).toBe("Oct 31, 2026");
  });
  it("falls back to the product default zone and tolerates empty or bad values", () => {
    expect(formatStudioDate(paidAt, null)).toBe("Oct 9, 2026");
    expect(formatStudioDate(paidAt, "")).toBe("Oct 9, 2026");
    expect(formatStudioDate(null, "America/New_York")).toBe("—");
    expect(formatStudioDate("not a date", "America/New_York")).toBe("—");
  });
  it("shows a date-only business date unchanged in any zone", () => {
    expect(formatStudioDate("2026-10-09", "Pacific/Kiritimati")).toBe("Oct 9, 2026");
    expect(formatStudioDate("2026-10-09", "America/Los_Angeles")).toBe("Oct 9, 2026");
  });
  it("does not depend on the process (server) time zone", () => {
    const original = process.env.TZ;
    try {
      for (const zone of ["Pacific/Kiritimati", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = zone;
        expect(formatStudioDate(paidAt, "America/New_York")).toBe("Oct 9, 2026");
        expect(formatStudioDate(paidAt, "Asia/Tokyo")).toBe("Oct 10, 2026");
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
  it("the page formats the earning Paid date with the studio zone read from studios.timezone", () => {
    const page = readFileSync(path.join(path.resolve(__dirname, ".."), "page.tsx"), "utf8");
    expect(page).toContain("formatStudioDate(earning.paid_at, studioTimeZone)");
    expect(page).not.toContain("formatDate(earning.paid_at)");
    expect(page).toMatch(/from\("studios"\)\.select\("timezone"\)\.eq\("id", studioId\)/);
  });
});
