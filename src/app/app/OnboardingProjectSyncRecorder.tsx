"use client";

import { useEffect, useRef } from "react";
import { syncWorkspaceOnboardingProjectAction } from "@/app/app/onboarding-actions";

export type OnboardingMilestoneSync = {
  key: string;
  title: string;
  domain: string;
  complete: boolean;
  sequence: number;
};

export function OnboardingProjectSyncRecorder({
  checklistType,
  milestones,
  readinessScore,
  nextMilestoneKey,
}: {
  checklistType: "studio" | "organizer";
  milestones: OnboardingMilestoneSync[];
  readinessScore: number;
  nextMilestoneKey: string | null;
}) {
  const payloadKey = JSON.stringify({
    checklistType,
    milestones,
    readinessScore,
    nextMilestoneKey,
  });
  const lastSubmitted = useRef<string | null>(null);

  useEffect(() => {
    if (lastSubmitted.current === payloadKey) return;
    lastSubmitted.current = payloadKey;

    void syncWorkspaceOnboardingProjectAction({
      checklistType,
      milestones,
      readinessScore,
      nextMilestoneKey,
    });
  }, [checklistType, milestones, nextMilestoneKey, payloadKey, readinessScore]);

  return null;
}
