import { fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { MutationNotice, mutationFailureCopy } from "@/components/MutationNotice";
import type { MutationFailureKind, MutationState } from "@/lib/mutation";
import { auditA11y } from "@/test-utils/a11y";

jest.setTimeout(20_000);

describe("ConfirmSheet", () => {
  beforeEach(() => {
    jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const base = { visible: true, title: "Mark Ana as no-show?", body: "One lesson credit is used.", confirmLabel: "Mark no-show" };

  it("shows the consequence, a primary confirm and a quiet cancel, and each calls back once", () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(<ConfirmSheet {...base} onConfirm={onConfirm} onCancel={onCancel} testID="sheet" />);
    expect(screen.getByText("Mark Ana as no-show?")).toBeTruthy();
    expect(screen.getByText("One lesson credit is used.")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Mark no-show"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByLabelText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("is a modal for assistive tech and announces itself on iOS", () => {
    render(<ConfirmSheet {...base} onConfirm={jest.fn()} onCancel={jest.fn()} testID="sheet" />);
    const sheet = screen.getByTestId("sheet");
    expect(sheet.props.accessibilityViewIsModal).toBe(true);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith("Mark Ana as no-show?. One lesson credit is used.");
  });

  it("while busy both buttons are disabled, so a second tap sends nothing", () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(<ConfirmSheet {...base} busy onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.press(screen.getByLabelText("Mark no-show"));
    fireEvent.press(screen.getByLabelText("Cancel"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Mark no-show").props.accessibilityState).toMatchObject({ disabled: true, busy: true });
  });

  it("renders nothing when not visible", () => {
    render(<ConfirmSheet {...base} visible={false} onConfirm={jest.fn()} onCancel={jest.fn()} testID="sheet" />);
    expect(screen.queryByTestId("sheet")).toBeNull();
  });

  it("passes the static accessibility audit: roles and names, 44 pt targets, text that can scale to 200%", () => {
    render(<ConfirmSheet {...base} onConfirm={jest.fn()} onCancel={jest.fn()} testID="sheet" />);
    expect(auditA11y(screen.UNSAFE_root)).toEqual([]);
  });
});

const FAILURE_KINDS: MutationFailureKind[] = [
  "offline",
  "timeout",
  "unavailable",
  "rate_limited",
  "conflict",
  "writes_disabled",
  "upgrade_required",
  "sign_in_again",
  "account_inactive",
  "platform_admin",
  "no_access",
  "paused",
  "not_permitted",
  "not_found",
  "not_markable",
  "client_bug",
];

function failed(kind: MutationFailureKind, over: Record<string, unknown> = {}): MutationState<unknown> {
  const unconfirmed = kind === "offline" || kind === "timeout";
  return { status: "failed", kind, error: new Error("x"), unconfirmed, retryable: unconfirmed || kind === "rate_limited" || kind === "unavailable", ...over } as MutationState<unknown>;
}

describe("MutationNotice", () => {
  const handlers = () => ({ onRetry: jest.fn(), onDiscard: jest.fn(), onDismiss: jest.fn(), onRefresh: jest.fn(), onSignInAgain: jest.fn() });

  it("renders nothing for idle and success, and a polite Saving… while pending", () => {
    const h = handlers();
    const { rerender } = render(<MutationNotice state={{ status: "idle" }} {...h} />);
    expect(screen.queryByTestId("mutation-notice")).toBeNull();
    rerender(<MutationNotice state={{ status: "success", result: 1 }} {...h} />);
    expect(screen.queryByTestId("mutation-notice")).toBeNull();
    rerender(<MutationNotice state={{ status: "pending", attempt: 1 }} {...h} />);
    expect(screen.getByTestId("mutation-notice-saving").props.accessibilityLiveRegion).toBe("polite");
  });

  it("every failure kind has its own words, and all of them say what happened to the change", () => {
    const seen = new Set<string>();
    for (const kind of FAILURE_KINDS) {
      const copy = mutationFailureCopy({ kind, unconfirmed: kind === "offline" || kind === "timeout", retryAfterSeconds: undefined });
      expect(copy.title.length).toBeGreaterThan(3);
      expect(copy.body).toMatch(/Nothing was changed|saved|turned off|Update it|Refresh|can't tell|unavailable/i);
      seen.add(`${copy.title}|${copy.body}`);
    }
    expect(seen.size).toBeGreaterThanOrEqual(14);
  });

  it("an unconfirmed failure offers Try again and Discard, never Dismiss (the change may be saved)", () => {
    const h = handlers();
    render(<MutationNotice state={failed("offline")} {...h} />);
    fireEvent.press(screen.getByLabelText("Try again"));
    fireEvent.press(screen.getByLabelText("Discard this change"));
    expect(h.onRetry).toHaveBeenCalledTimes(1);
    expect(h.onDiscard).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Dismiss")).toBeNull();
  });

  it("states the specific recovery per kind: upgrade and writes-off have no Retry; a conflict offers Refresh; a 429 says how long to wait", () => {
    const h = handlers();
    const { rerender } = render(<MutationNotice state={failed("upgrade_required")} {...h} />);
    expect(screen.getByText("Update DanceFlow Business")).toBeTruthy();
    expect(screen.queryByLabelText("Retry")).toBeNull();
    rerender(<MutationNotice state={failed("writes_disabled")} {...h} />);
    expect(screen.getByText("This change is turned off")).toBeTruthy();
    expect(screen.queryByLabelText("Retry")).toBeNull();
    rerender(<MutationNotice state={failed("conflict", { retryable: false })} {...h} />);
    fireEvent.press(screen.getByLabelText("Refresh"));
    expect(h.onRefresh).toHaveBeenCalledTimes(1);
    rerender(<MutationNotice state={failed("rate_limited", { retryAfterSeconds: 30 })} {...h} />);
    expect(screen.getByText(/Wait about 30 seconds/)).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Retry"));
    expect(h.onRetry).toHaveBeenCalledTimes(1);
  });

  it("sign-in failures offer the way out", () => {
    const h = handlers();
    render(<MutationNotice state={failed("sign_in_again")} {...h} />);
    fireEvent.press(screen.getByLabelText("Sign in again"));
    expect(h.onSignInAgain).toHaveBeenCalledTimes(1);
  });

  it("is an alert with named, 44 pt, scalable controls for every failure kind", () => {
    for (const kind of FAILURE_KINDS) {
      const { unmount } = render(<MutationNotice state={failed(kind)} {...handlers()} />);
      expect(auditA11y(screen.UNSAFE_root)).toEqual([]);
      unmount();
    }
  });
});
