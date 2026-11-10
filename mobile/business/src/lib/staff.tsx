import type React from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { StaffApi, StaffMe, StaffWorkspace } from "@/lib/staffApi";
import { pickDefaultWorkspace } from "@/lib/navigation";

/*
  The staff API instance and the result of GET /api/staff/me, shared by every screen.
  The selected workspace is held in memory only: the API has no selected-workspace state,
  and every workspace route names its studio explicitly.
*/

const StaffApiContext = createContext<StaffApi | null>(null);

export function StaffApiProvider({ api, children }: { api: StaffApi; children: React.ReactNode }) {
  return <StaffApiContext.Provider value={api}>{children}</StaffApiContext.Provider>;
}

export function useStaffApi() {
  const api = useContext(StaffApiContext);
  if (!api) throw new Error("useStaffApi must be used inside StaffApiProvider");
  return api;
}

type StaffSessionValue = {
  me: StaffMe | null;
  loading: boolean;
  error: unknown;
  workspace: StaffWorkspace | null;
  selectWorkspace: (studioId: string) => void;
  reload: () => Promise<void>;
  /** Ends the local session; the root layout then shows sign-in. */
  signOut: () => Promise<void>;
};

const StaffSessionContext = createContext<StaffSessionValue | null>(null);

export function StaffSessionProvider({
  children,
  signOut,
}: {
  children: React.ReactNode;
  signOut: () => Promise<void>;
}) {
  const api = useStaffApi();
  const [me, setMe] = useState<StaffMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMe(await api.me());
    } catch (failure) {
      setError(failure);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const workspace = useMemo(
    () => (me ? pickDefaultWorkspace(me.workspaces, selectedId) : null),
    [me, selectedId],
  );

  const value = useMemo(
    () => ({ me, loading, error, workspace, selectWorkspace: setSelectedId, reload, signOut }),
    [me, loading, error, workspace, reload, signOut],
  );

  return <StaffSessionContext.Provider value={value}>{children}</StaffSessionContext.Provider>;
}

/** Tests and previews can supply a fixed value without a network. */
export const StaffSessionTestProvider = StaffSessionContext.Provider;

export function useStaffSession() {
  const value = useContext(StaffSessionContext);
  if (!value) throw new Error("useStaffSession must be used inside StaffSessionProvider");
  return value;
}
