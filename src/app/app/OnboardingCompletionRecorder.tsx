"use client";

import { useEffect, useRef } from "react";
import { completeWorkspaceOnboardingAction } from "@/app/app/onboarding-actions";

export function OnboardingCompletionRecorder({
  checklistType,
}: {
  checklistType: "studio" | "organizer";
}) {
  const hasSubmitted = useRef(false);

  useEffect(() => {
    if (hasSubmitted.current) return;

    hasSubmitted.current = true;

    void completeWorkspaceOnboardingAction(checklistType);
  }, [checklistType]);

  return null;
}