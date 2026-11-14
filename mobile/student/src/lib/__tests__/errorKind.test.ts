import { classifyError } from "@/lib/errorKind";

describe("classifyError", () => {
  it.each([
    ["Network request failed", "offline"],
    [new TypeError("Failed to fetch"), "offline"],
    ["The request timed out.", "offline"],
    ["Authentication required.", "signedOut"],
    ["JWT expired", "signedOut"],
    ["Not authorized to manage this roster.", "forbidden"],
    ['new row violates row-level security policy (42501)', "forbidden"],
    ["This recap could not be found.", "notFound"],
    ["Event not found", "notFound"],
    ["Stripe returned an unexpected response.", "unknown"],
    ["", "unknown"],
    [null, "unknown"],
    [undefined, "unknown"]
  ])("%p is %s", (error, kind) => {
    expect(classifyError(error)).toBe(kind);
  });
});
