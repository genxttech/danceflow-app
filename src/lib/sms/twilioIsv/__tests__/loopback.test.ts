import { describe, expect, it } from "vitest";
import { fakeAdapterAllowed } from "../config";
import { isLoopbackHost, isLoopbackUrl, LOOPBACK_HOSTS } from "../loopback";
import { loopbackUrl } from "../validation/stage";

describe("the single loopback definition used by every TW-4 safety check", () => {
  it("accepts exactly the three loopback hostnames", () => {
    expect([...LOOPBACK_HOSTS].sort()).toEqual(["127.0.0.1", "[::1]", "localhost"]);
    for (const url of ["http://127.0.0.1:55321", "http://localhost:3000/x", "http://[::1]:8080", "https://localhost"]) expect(isLoopbackUrl(url)).toBe(true);
  });
  it("refuses lookalikes, userinfo tricks, remote hosts, trailing dots and unparseable input", () => {
    for (const url of ["https://localhost.evil.com", "http://127.0.0.1.evil.com", "http://127.0.0.1@evil.com", "https://evil.com/127.0.0.1", "http://localhost.:80", "http://127.0.0.2", "http://0.0.0.0", "https://epdrtzcydvnoidwrepqz.supabase.co", "", "not a url"]) {
      expect(isLoopbackUrl(url), url).toBe(false);
    }
    expect(isLoopbackHost("localhost.")).toBe(false);
    expect(isLoopbackHost("LOCALHOST")).toBe(false); // URL.hostname is already lower-cased, so only the canonical form is ever compared
  });
  it("the stage guard and the fake-adapter check use the same definition", () => {
    expect(loopbackUrl).toBe(isLoopbackUrl);
    const env = { TW4_ISV_FAKE: "on", NODE_ENV: "test" };
    expect(fakeAdapterAllowed({ ...env, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" })).toBe(true);
    expect(fakeAdapterAllowed({ ...env, NEXT_PUBLIC_SUPABASE_URL: "http://localhost.evil.com" })).toBe(false);
  });
});
