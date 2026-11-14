/*
  Push setup state machine, independent of the native module. The real adapter (expo-notifications) is added with the
  dependency, which needs an owner-approved package.json change; until then screens can be built and tested against this.

  Rules: never prompt without a user action; a denied permission is a normal state (explain, link to settings), not an
  error; a missing credential (no FCM/APNs, no project id) is "unavailable" and the app carries on; a failed token read
  never blocks sign-in. The token is a device address, kept out of logs, and is handed to the server only through
  `register` (no staff endpoint exists yet: see the contract proposal).
*/

export type PermissionState = "undetermined" | "granted" | "denied";

export type PushAdapter = {
  getPermission: () => Promise<PermissionState>;
  /** Shows the OS prompt. Only ever called from a user action. */
  requestPermission: () => Promise<PermissionState>;
  /** Rejects when credentials or the project id are missing. */
  getDeviceToken: () => Promise<string>;
};

export type PushStatus =
  | { kind: "not_asked" }
  | { kind: "denied" }
  | { kind: "unavailable"; reason: "no_credentials" }
  | { kind: "ready"; registered: boolean };

export type PushRegister = (token: string) => Promise<void>;

/** What to show without prompting: reads the permission and, when granted, tries to register. */
export async function readPushStatus(adapter: PushAdapter, register?: PushRegister): Promise<PushStatus> {
  const permission = await adapter.getPermission().catch(() => "undetermined" as const);
  if (permission === "undetermined") return { kind: "not_asked" };
  if (permission === "denied") return { kind: "denied" };
  return registerToken(adapter, register);
}

/** The user tapped "Turn on notifications". */
export async function enablePush(adapter: PushAdapter, register?: PushRegister): Promise<PushStatus> {
  const permission = await adapter.requestPermission().catch(() => "denied" as const);
  if (permission !== "granted") return permission === "undetermined" ? { kind: "not_asked" } : { kind: "denied" };
  return registerToken(adapter, register);
}

async function registerToken(adapter: PushAdapter, register?: PushRegister): Promise<PushStatus> {
  let token: string;
  try {
    token = await adapter.getDeviceToken();
  } catch {
    return { kind: "unavailable", reason: "no_credentials" };
  }
  if (!register) return { kind: "ready", registered: false };
  try {
    await register(token);
    return { kind: "ready", registered: true };
  } catch {
    // The server could not take the token now; permission is fine, so the status stays ready and a later launch retries.
    return { kind: "ready", registered: false };
  }
}
