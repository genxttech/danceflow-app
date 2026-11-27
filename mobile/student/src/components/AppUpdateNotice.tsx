import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { AppButton } from "@/components/AppButton";
import { FeatureCard } from "@/components/FeatureCard";
import {
  APP_CONFIG_REFRESH_MS,
  dismissNotice,
  isNoticeDismissed,
  loadAppConfig,
  ownBuildNumber,
  updateNoticeFor,
  type UpdateNotice,
} from "@/lib/appConfig";
import { openWebUrl } from "@/lib/openWebUrl";

/**
 * A dismissible "newer version available" card. It renders nothing until the configuration answers with a higher recommended build, never
 * delays the screen around it, and never blocks anything.
 */
export function AppUpdateNotice() {
  const [notice, setNotice] = useState<UpdateNotice | null>(null);
  const checkedAt = useRef(0);

  useEffect(() => {
    let mounted = true;

    async function check() {
      checkedAt.current = Date.now();
      const next = updateNoticeFor(await loadAppConfig(), ownBuildNumber());
      const hidden = next ? await isNoticeDismissed(next.recommendedCode) : false;
      if (mounted) setNotice(hidden ? null : next);
    }

    void check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && Date.now() - checkedAt.current >= APP_CONFIG_REFRESH_MS) void check();
    });

    return () => {
      mounted = false;
      subscription?.remove();
    };
  }, []);

  if (!notice) return null;

  return (
    <>
      <FeatureCard title="Update available" detail="A newer version of DanceFlow is available." />
      {notice.storeUrl ? <AppButton label="Update" onPress={() => void openWebUrl(notice.storeUrl)} /> : null}
      <AppButton
        label="Not now"
        variant="secondary"
        onPress={() => {
          void dismissNotice(notice.recommendedCode);
          setNotice(null);
        }}
      />
    </>
  );
}
