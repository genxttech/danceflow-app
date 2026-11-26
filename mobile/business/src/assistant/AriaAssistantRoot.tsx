import type { ComponentType, ReactNode } from "react";
import { isStaffFeatureEnabled } from "@/lib/features";

/*
  The only thing the app's layout imports. With the ariaAssistant flag off (the default and the release default) it returns its children untouched:
  the assistant implementation is never required, so nothing is evaluated, rendered, stored or sent.
*/

export function makeAriaAssistantRoot(enabled: boolean) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded only when the flag is on
  const Impl: ComponentType<{ children: ReactNode }> | null = enabled ? require("./AriaAssistantImpl").default : null;
  return function AriaAssistantRoot({ children }: { children: ReactNode }) {
    return Impl ? <Impl>{children}</Impl> : <>{children}</>;
  };
}

export const AriaAssistantRoot = makeAriaAssistantRoot(isStaffFeatureEnabled("ariaAssistant"));
