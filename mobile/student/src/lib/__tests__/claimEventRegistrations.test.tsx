import { render, waitFor } from "@testing-library/react-native";
import { WARM_UP_TIMEOUT_MS, warmUpRenderer } from "@/test/warmUpRenderer";

const mockRpc = jest.fn();
jest.mock("@/lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => mockRpc(...a) } }));

import { claimMyEventRegistrations, resetClaimAttemptsForTests, useClaimEventRegistrations } from "@/lib/claimEventRegistrations";

function Probe({ userId, onClaimed }: { userId: string | null; onClaimed: (n: number) => void }) {
  useClaimEventRegistrations(userId, onClaimed);
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
});
