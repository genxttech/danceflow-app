import { useMemo, type ReactNode } from "react";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { useFontScale } from "@/lib/fontScale";
import { colors } from "@/theme";
import { ARIA_STUB_FALLBACK, ariaConfig, ariaStubRules } from "./ariaConfig";
import { descriptorForRoute } from "./ariaScreenReporter";
import { AssistantProvider, useAssistantScreen } from "./shared/provider";
import { createStubResponder } from "./shared/stubResponder";
import { AssistantHost, type AssistantTheme } from "./shared/ui";

/* Loaded only when the ariaAssistant flag is on (see AriaAssistantRoot). Mounted inside the signed-in providers, so a sign-out or user switch drops the thread. */

const theme: AssistantTheme = {
  background: colors.surface,
  surface: colors.raised,
  text: colors.text,
  muted: colors.muted,
  border: colors.border,
  primary: colors.plum,
  onPrimary: colors.onPlum,
  danger: colors.error,
  scrim: "rgba(0,0,0,0.4)",
};

/** Routes where the launcher must not appear. */
const HIDDEN_PATHS = ["/sign-in", "/auth/callback"];

/** Same arithmetic as the tab bar in app/(tabs)/_layout.tsx (bottom inset is added by the launcher itself). */
export function launcherOffset(fontScale: number) {
  const label = Math.ceil(12 * 1.35 * Math.max(1, fontScale));
  return 8 + 24 + 4 + label + 8 + 8;
}

function ScreenReporter() {
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const descriptor = useMemo(() => descriptorForRoute(pathname, params), [pathname, params]);
  useAssistantScreen(descriptor);
  return null;
}

export default function AriaAssistantImpl({ children }: { children: ReactNode }) {
  const responder = useMemo(() => createStubResponder({ rules: ariaStubRules, fallback: ARIA_STUB_FALLBACK, delayMs: 400 }), []);
  const pathname = usePathname();
  const fontScale = useFontScale();
  const hidden = HIDDEN_PATHS.some((p) => pathname.startsWith(p));
  return (
    <AssistantProvider config={ariaConfig} responder={responder}>
      <ScreenReporter />
      {children}
      {hidden ? null : <AssistantHost theme={theme} bottomOffset={launcherOffset(fontScale)} onNavigate={(href) => router.push(href as Parameters<typeof router.push>[0])} />}
    </AssistantProvider>
  );
}
