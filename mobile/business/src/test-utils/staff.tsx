import type React from "react";
import { StaffApiProvider, StaffSessionTestProvider } from "@/lib/staff";
import type { StaffApi, StaffMe, StaffWorkspace } from "@/lib/staffApi";

export const STUDIO_ID = "studio-1";

export function workspace(overrides: Partial<StaffWorkspace> = {}): StaffWorkspace {
  return {
    studioId: STUDIO_ID,
    name: "Studio A",
    publicName: "Studio A Dance",
    slug: "studio-a",
    role: "front_desk",
    accessAllowed: true,
    subscriptionStatus: "active",
    capabilities: { viewStudioSchedule: true, viewClients: true, markAttendance: true },
    ...overrides,
  };
}

export function fakeApi(overrides: Partial<StaffApi> = {}): StaffApi & Record<keyof StaffApi, jest.Mock> {
  return {
    me: jest.fn(),
    today: jest.fn(),
    appointment: jest.fn(),
    searchClients: jest.fn(),
    client: jest.fn(),
    setAttendance: jest.fn(),
    ...overrides,
  } as StaffApi & Record<keyof StaffApi, jest.Mock>;
}

export function StaffTestProviders({
  api,
  ws = workspace(),
  signOut = jest.fn(async () => undefined),
  reload = jest.fn(async () => undefined),
  children,
}: {
  api: StaffApi;
  ws?: StaffWorkspace;
  signOut?: () => Promise<void>;
  reload?: () => Promise<void>;
  children: React.ReactNode;
}) {
  const me: StaffMe = { user: { id: "u1", email: "desk@example.test", fullName: "Desk Person" }, workspaces: [ws] };
  return (
    <StaffApiProvider api={api}>
      <StaffSessionTestProvider value={{ me, loading: false, error: null, workspace: ws, selectWorkspace: jest.fn(), reload, signOut }}>
        {children}
      </StaffSessionTestProvider>
    </StaffApiProvider>
  );
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
