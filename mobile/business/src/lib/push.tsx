import type React from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { routeForNotification, type NotificationTarget } from "@/lib/notificationRoute";
import { enablePush, readPushStatus, type PushAdapter, type PushRegister, type PushStatus } from "@/lib/pushSetup";

/** Where notification taps come from (the native module's response listener plus the launch notification). */
export type TapSource = {
  subscribe: (handler: (data: unknown) => void) => () => void;
  /** The notification that launched the app, if any. */
  getInitial: () => Promise<unknown | null>;
};

type PushConfig = { adapter: PushAdapter; taps?: TapSource; register?: PushRegister };

const PushContext = createContext<PushConfig | null>(null);

/** With no provider (or no adapter) the app simply has no push UI: that is the state until the native module is wired. */
export function PushProvider({ value, children }: { value: PushConfig | null; children: React.ReactNode }) {
  return <PushContext.Provider value={value}>{children}</PushContext.Provider>;
}

export function usePushSetup() {
  const config = useContext(PushContext);
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const adapter = config?.adapter;
  const register = config?.register;

  useEffect(() => {
    if (!adapter) return;
    let active = true;
    readPushStatus(adapter, register).then(
      (next) => active && setStatus(next),
      () => active && setStatus({ kind: "not_asked" }),
    );
    return () => {
      active = false;
    };
  }, [adapter, register]);

  /** Call only from a user action. */
  const enable = useCallback(async () => {
    if (!adapter) return;
    setBusy(true);
    try {
      setStatus(await enablePush(adapter, register));
    } finally {
      setBusy(false);
    }
  }, [adapter, register]);

  return { available: !!adapter, status, busy, enable };
}

/** Routes taps (live and the launch notification) with `navigate`. Unknown payloads open Today. */
export function usePushTaps(navigate: (target: NotificationTarget) => void) {
  const config = useContext(PushContext);
  const taps = config?.taps;
  const go = useRef(navigate);
  go.current = navigate;

  useEffect(() => {
    if (!taps) return;
    let active = true;
    const off = taps.subscribe((data) => go.current(routeForNotification(data)));
    taps.getInitial().then(
      (data) => {
        if (active && data) go.current(routeForNotification(data));
      },
      () => undefined,
    );
    return () => {
      active = false;
      off();
    };
  }, [taps]);
}
