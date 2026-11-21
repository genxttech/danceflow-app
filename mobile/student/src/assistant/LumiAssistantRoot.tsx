import type { ComponentType, ReactNode } from "react";
import { isDancerFeatureEnabled } from "@/lib/dancerFeatures";

/*
  The only thing the app's layout imports. With the lumiAssistant flag off (the default; no build config names it) it returns its children
  untouched: the implementation is never required, so nothing is evaluated, rendered, fetched or stored.
*/

export function makeLumiAssistantRoot(enabled: boolean) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded only when the flag is on
  const Impl: ComponentType<{ children: ReactNode }> | null = enabled ? require("./LumiAssistantImpl").default : null;
  return function LumiAssistantRoot({ children }: { children: ReactNode }) {
    return Impl ? <Impl>{children}</Impl> : <>{children}</>;
  };
}

export const LumiAssistantRoot = makeLumiAssistantRoot(isDancerFeatureEnabled("lumiAssistant"));
