import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, renderHook } from "@testing-library/react-native";
import { Dimensions, PixelRatio } from "react-native";
import { useFontScale } from "@/lib/fontScale";

describe("useFontScale", () => {
  afterEach(() => jest.restoreAllMocks());

  it("starts from the current scale and re-reads it after the first layout", () => {
    const spy = jest.spyOn(PixelRatio, "getFontScale").mockReturnValueOnce(1).mockReturnValue(2);
    const { result } = renderHook(() => useFontScale());
    expect(result.current).toBe(2); // first read 1, the post-layout read 2
    expect(spy).toHaveBeenCalled();
  });

  it("follows a change of the system text size while the app is open", () => {
    let handler: () => void = () => {};
    jest.spyOn(Dimensions, "addEventListener").mockImplementation(((_: string, h: () => void) => {
      handler = h;
      return { remove: jest.fn() };
    }) as never);
    const scale = jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(1);
    const { result } = renderHook(() => useFontScale());
    expect(result.current).toBe(1);
    scale.mockReturnValue(2);
    act(() => handler());
    expect(result.current).toBe(2);
  });

  it("stops listening when unmounted", () => {
    const remove = jest.fn();
    jest.spyOn(Dimensions, "addEventListener").mockReturnValue({ remove } as never);
    const { unmount } = renderHook(() => useFontScale());
    unmount();
    expect(remove).toHaveBeenCalled();
  });

  it("is applied: the root stack is keyed by it and the tab bar reads it", () => {
    const read = (p: string) => readFileSync(join(__dirname, "..", "..", "..", p), "utf8");
    expect(read("app/_layout.tsx")).toContain("key={`font-${fontScale}`}");
    expect(read("app/(tabs)/_layout.tsx")).toContain("useFontScale()");
    expect(read("app/(tabs)/_layout.tsx")).not.toContain("useWindowDimensions");
  });
});
