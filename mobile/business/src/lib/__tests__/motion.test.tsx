import { act, renderHook } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";
import { stackAnimation, useReduceMotion } from "@/lib/motion";

describe("Reduce Motion", () => {
  it("replaces the stack slide with a fade", () => {
    expect(stackAnimation(true)).toBe("fade");
    expect(stackAnimation(false)).toBe("default");
  });

  it("follows the system setting, including changes while open", async () => {
    let listener: ((value: boolean) => void) | undefined;
    const remove = jest.fn();
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementation(((_event: string, handler: (value: boolean) => void) => {
      listener = handler;
      return { remove };
    }) as never);

    const { result, unmount } = renderHook(() => useReduceMotion());
    await act(async () => undefined);
    expect(result.current).toBe(true);

    act(() => listener?.(false));
    expect(result.current).toBe(false);

    unmount();
    expect(remove).toHaveBeenCalled();
  });
});
