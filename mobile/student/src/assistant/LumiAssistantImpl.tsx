import { useEffect, useMemo, useState, type ReactNode } from "react";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { useColorScheme } from "react-native";
import { colorsForScheme } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { useFontScale } from "@/lib/fontScale";
import { getStudentAccess } from "@/lib/studentAccess";
import { tabBarMetrics } from "@/lib/tabBar";
import { LUMI_STUB_FALLBACK, lumiConfig, lumiStubRules } from "./lumiConfig";
import { descriptorForRoute } from "./lumiScreenReporter";
import { AssistantProvider, useAssistantScreen } from "./shared/provider";
import { createStubResponder } from "./shared/stubResponder";
import { AssistantHost, type AssistantTheme } from "./shared/ui";

/*
  Loaded only when the lumiAssistant flag is on (see LumiAssistantRoot). Shows nothing until the signed-in dancer's server access says
  lumiEnabled; that one read (the same endpoint the LUMI screen uses) happens only with the flag on. Keyed by user id so a sign-out or
  user switch drops the thread.
*/

/** Routes where the launcher must not appear: sign-in, the existing LUMI modal, and forms (registration) where it would sit on the primary action. */
const HIDDEN = ["/sign-in", "/auth", "/lumi", "/register"];

function ScreenReporter() {
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const descriptor = useMemo(() => descriptorForRoute(pathname, params), [pathname, params]);
  useAssistantScreen(descriptor);
  return null;
}

/** A sibling of the navigator (not a wrapper), so the app tree does not remount when access resolves. */
function Overlay() {
  const scheme = useColorScheme();
  const colors = colorsForScheme(scheme);
  const pathname = usePathname();
  const fontScale = useFontScale();
  const responder = useMemo(() => createStubResponder({ rules: lumiStubRules, fallback: LUMI_STUB_FALLBACK, delayMs: 400 }), []);
  const theme: AssistantTheme = {
    background: colors.background,
    surface: colors.surface,
    text: colors.text,
    muted: colors.muted,
    border: colors.border,
    primary: colors.primary,
    onPrimary: colors.onPrimary,
    danger: colors.danger,
    scrim: "rgba(0,0,0,0.4)",
  };
  const hidden = HIDDEN.some((p) => pathname.includes(p));
  // Sit above the tab bar (its height without the inset, which the launcher adds itself).
  const offset = tabBarMetrics(fontScale, 0).height;
  return (
    <AssistantProvider config={lumiConfig} responder={responder}>
      <ScreenReporter />
      {hidden ? null : <AssistantHost theme={theme} bottomOffset={offset} onNavigate={(href) => router.push(href as never)} />}
    </AssistantProvider>
  );
}

export default function LumiAssistantImpl({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [allowed, setAllowed] = useState<{ userId: string; lumiEnabled: boolean } | null>(null);

  useEffect(() => {
    if (!userId) return undefined;
    let live = true;
    getStudentAccess(userId)
      .then((access) => live && setAllowed({ userId, lumiEnabled: access.lumiEnabled === true }))
      .catch(() => live && setAllowed({ userId, lumiEnabled: false }));
    return () => {
      live = false;
    };
  }, [userId]);

  const on = !!userId && allowed?.userId === userId && allowed.lumiEnabled;
  return (
    <>
      {children}
      {on ? <Overlay key={userId} /> : null}
    </>
  );
}
