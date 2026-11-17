import { render, waitFor } from "@testing-library/react-native";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

const mockRpc = jest.fn();
jest.mock("@/lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => mockRpc(...a) } }));

import { claimEligibleUserId, claimMyEventRegistrations, resetClaimAttemptsForTests, useClaimEventRegistrations } from "@/lib/claimEventRegistrations";

function Probe({ userId, onClaimed, confirmed = true, email = "d@example.test" }: { userId: string | null; onClaimed: (n: number) => void; confirmed?: boolean; email?: string | null }) {
  useClaimEventRegistrations(userId ? { id: userId, email, email_confirmed_at: confirmed ? "2026-11-01T00:00:00Z" : null } : null, onClaimed);
  return null;
}

beforeAll(warmUpRenderer, WARM_UP_TIMEOUT_MS);
beforeEach(() => {
  mockRpc.mockReset();
  resetClaimAttemptsForTests();
});

describe("claim_my_event_registrations from the app", () => {
  it("N claimed: reports the count so the screen reloads its tickets; the rpc is called with no arguments", async () => {
    mockRpc.mockResolvedValue({ data: 2, error: null });
    const onClaimed = jest.fn();
    render(<Probe userId="u1" onClaimed={onClaimed} />);
    await waitFor(() => expect(onClaimed).toHaveBeenCalledWith(2));
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("claim_my_event_registrations");
  });

  it("0 claimed: no reload", async () => {
    mockRpc.mockResolvedValue({ data: 0, error: null });
    const onClaimed = jest.fn();
    render(<Probe userId="u1" onClaimed={onClaimed} />);
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(onClaimed).not.toHaveBeenCalled();
  });

  it("function missing (PGRST202) or any error: silent, no reload, and no retry storm", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const onClaimed = jest.fn();
    const view = render(<Probe userId="u1" onClaimed={onClaimed} />);
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
    view.rerender(<Probe userId="u1" onClaimed={onClaimed} />);
    view.rerender(<Probe userId="u1" onClaimed={onClaimed} />);
    await expect(claimMyEventRegistrations("u1")).resolves.toBe(0);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(onClaimed).not.toHaveBeenCalled();
  });

  it("a thrown network error is swallowed too", async () => {
    mockRpc.mockRejectedValue(new Error("Network request failed"));
    await expect(claimMyEventRegistrations("u1")).resolves.toBe(0);
    await expect(claimMyEventRegistrations("u1")).resolves.toBe(0);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it("signed out: no call", async () => {
    const onClaimed = jest.fn();
    render(<Probe userId={null} onClaimed={onClaimed} />);
    await expect(claimMyEventRegistrations(null)).resolves.toBe(0);
    await expect(claimMyEventRegistrations(undefined)).resolves.toBe(0);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("at most once per user per run, shared by two screens asking at once; a different user is asked separately", async () => {
    mockRpc.mockResolvedValue({ data: 1, error: null });
    const a = jest.fn();
    const b = jest.fn();
    render(<><Probe userId="u1" onClaimed={a} /><Probe userId="u1" onClaimed={b} /></>);
    await waitFor(() => expect(a).toHaveBeenCalledWith(1));
    expect(b).toHaveBeenCalledWith(1);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    await claimMyEventRegistrations("u2");
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it("a non-integer or negative return is treated as nothing claimed", async () => {
    mockRpc.mockResolvedValue({ data: "3", error: null });
    await expect(claimMyEventRegistrations("u1")).resolves.toBe(0);
    resetClaimAttemptsForTests();
    mockRpc.mockResolvedValue({ data: -1, error: null });
    await expect(claimMyEventRegistrations("u1")).resolves.toBe(0);
  });

  it("an unverified-email session never calls the function (no confirmed email, or no email at all)", async () => {
    const onClaimed = jest.fn();
    render(<Probe userId="u1" confirmed={false} onClaimed={onClaimed} />);
    render(<Probe userId="u2" email={null} onClaimed={onClaimed} />);
    await Promise.resolve();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(onClaimed).not.toHaveBeenCalled();
    expect(claimEligibleUserId({ id: "u1", email: "a@b.test", email_confirmed_at: null })).toBeNull();
    expect(claimEligibleUserId({ id: "u1", email: "", email_confirmed_at: "x" })).toBeNull();
    expect(claimEligibleUserId(null)).toBeNull();
    expect(claimEligibleUserId(undefined)).toBeNull();
    expect(claimEligibleUserId({ id: "u1", email: "a@b.test", email_confirmed_at: "2026-11-01" })).toBe("u1");
  });

  it("a user who is unverified at first and confirmed later is then asked exactly once", async () => {
    mockRpc.mockResolvedValue({ data: 1, error: null });
    const onClaimed = jest.fn();
    const view = render(<Probe userId="u1" confirmed={false} onClaimed={onClaimed} />);
    await Promise.resolve();
    expect(mockRpc).not.toHaveBeenCalled();
    view.rerender(<Probe userId="u1" confirmed onClaimed={onClaimed} />);
    await waitFor(() => expect(onClaimed).toHaveBeenCalledWith(1));
    view.rerender(<Probe userId="u1" confirmed onClaimed={onClaimed} />);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});
