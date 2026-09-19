import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  describeInstructorSeatNotice,
  getInstructorSeatStatus,
} from "../seatStatus";
import { InstructorSeatNotice } from "@/components/InstructorSeatNotice";

function rpcClient(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { rpc, client: { rpc } as never };
}

describe("getInstructorSeatStatus", () => {
  it("maps the RPC row (array or object) to the derived status and passes only the studio id", async () => {
    const { rpc, client } = rpcClient({
      data: [{ seat_limit: 1, counted_usage: 3, over_limit: true }],
      error: null,
    });

    await expect(getInstructorSeatStatus(client, "studio-1")).resolves.toEqual({
      seatLimit: 1,
      countedUsage: 3,
      overLimit: true,
    });
    expect(rpc).toHaveBeenCalledWith("get_instructor_seat_status", { p_studio_id: "studio-1" });

    const single = rpcClient({ data: { seat_limit: 5, counted_usage: 2, over_limit: false }, error: null });
    await expect(getInstructorSeatStatus(single.client, "s")).resolves.toMatchObject({ overLimit: false });
  });

  it("returns null (no notice) on error, missing data, or a malformed row -- enforcement lives in the DB", async () => {
    await expect(getInstructorSeatStatus(rpcClient({ data: null, error: { message: "boom" } }).client, "s")).resolves.toBeNull();
    await expect(getInstructorSeatStatus(rpcClient({ data: null, error: null }).client, "s")).resolves.toBeNull();
    await expect(getInstructorSeatStatus(rpcClient({ data: [{}], error: null }).client, "s")).resolves.toBeNull();
    await expect(getInstructorSeatStatus(rpcClient({ data: [], error: null }).client, "s")).resolves.toBeNull();
  });
});

describe("describeInstructorSeatNotice", () => {
  it("shows nothing unless usage exceeds the limit (below / exactly at)", () => {
    expect(describeInstructorSeatNotice(null)).toBeNull();
    expect(describeInstructorSeatNotice({ seatLimit: 5, countedUsage: 2, overLimit: false })).toBeNull();
    expect(describeInstructorSeatNotice({ seatLimit: 1, countedUsage: 1, overLimit: false })).toBeNull();
  });

  it("plan overage: names the limit and usage, says existing instructors keep working and additions are frozen", () => {
    const copy = describeInstructorSeatNotice({ seatLimit: 1, countedUsage: 5, overLimit: true });
    expect(copy?.kind).toBe("plan");
    expect(copy?.body).toContain("includes 1 instructor seat");
    expect(copy?.body).toContain("5 are in use");
    expect(copy?.body).toMatch(/Existing instructors keep working/);
    expect(copy?.body).toMatch(/can't add or reactivate instructors/);

    const plural = describeInstructorSeatNotice({ seatLimit: 5, countedUsage: 6, overLimit: true });
    expect(plural?.body).toContain("includes 5 instructor seats");
    expect(plural?.body).toContain("6 are in use");
  });

  it("limit 0 is worded as inactive billing, not a downgrade to a zero-seat plan", () => {
    const copy = describeInstructorSeatNotice({ seatLimit: 0, countedUsage: 2, overLimit: true });
    expect(copy?.kind).toBe("inactive_subscription");
    expect(copy?.body).toContain("subscription isn't active");
    expect(copy?.body).toMatch(/Existing instructors keep working/);
    expect(copy?.body).not.toMatch(/includes 0/);
  });
});

describe("InstructorSeatNotice", () => {
  const render = (props: Parameters<typeof InstructorSeatNotice>[0]) =>
    renderToStaticMarkup(createElement(InstructorSeatNotice, props));

  it("renders nothing when not over limit or status is unavailable", () => {
    expect(render({ status: null })).toBe("");
    expect(render({ status: { seatLimit: 5, countedUsage: 5, overLimit: false } })).toBe("");
  });

  it("renders one notice with Manage instructors and Upgrade plan actions", () => {
    const html = render({ status: { seatLimit: 1, countedUsage: 4, overLimit: true } });
    expect(html).toContain("Manage instructors");
    expect(html).toContain('href="/app/instructors"');
    expect(html).toContain("Upgrade plan");
    expect(html).toContain('href="/app/settings/billing"');
    expect((html.match(/role="status"/g) ?? []).length).toBe(1);
  });

  it("can hide the manage link (instructors page) and words the billing action for inactive subscriptions", () => {
    const onInstructors = render({ status: { seatLimit: 1, countedUsage: 4, overLimit: true }, showManageLink: false });
    expect(onInstructors).not.toContain("Manage instructors");
    expect(onInstructors).toContain("Upgrade plan");

    const inactive = render({ status: { seatLimit: 0, countedUsage: 1, overLimit: true } });
    expect(inactive).toContain("Update billing");
    expect(inactive).not.toContain("Upgrade plan");
  });
});
