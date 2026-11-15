// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addFontScale } = require("../../plugins/withFontScaleConfigChange");

const manifest = (configChanges?: string) => ({
  manifest: {
    application: [
      {
        activity: [
          { $: { "android:name": ".Other", "android:configChanges": "orientation" } },
          { $: { "android:name": ".MainActivity", ...(configChanges === undefined ? {} : { "android:configChanges": configChanges }) } },
        ],
      },
    ],
  },
});

const main = (m: ReturnType<typeof manifest>) => m.manifest.application[0].activity[1].$["android:configChanges"];

describe("withFontScaleConfigChange", () => {
  it("adds fontScale to MainActivity's configChanges and keeps the existing entries", () => {
    expect(main(addFontScale(manifest("keyboard|orientation|uiMode")))).toBe("fontScale|keyboard|orientation|uiMode");
  });
  it("is idempotent", () => {
    const once = addFontScale(manifest("keyboard|uiMode"));
    expect(main(addFontScale(once))).toBe("fontScale|keyboard|uiMode");
  });
  it("sets it when the activity had none, and leaves other activities alone", () => {
    const m = addFontScale(manifest());
    expect(main(m)).toBe("fontScale");
    expect(m.manifest.application[0].activity[0].$["android:configChanges"]).toBe("orientation");
  });
  it("does nothing when there is no MainActivity", () => {
    const m = { manifest: { application: [{ activity: [] }] } };
    expect(addFontScale(m)).toEqual({ manifest: { application: [{ activity: [] }] } });
  });
});
