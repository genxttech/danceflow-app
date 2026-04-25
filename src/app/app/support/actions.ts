"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type SupportIssueType =
  | "technical"
  | "billing"
  | "account_access"
  | "feature_question"
  | "other";

const ISSUE_TYPES = new Set<SupportIssueType>([
  "technical",
  "billing",
  "account_access",
  "feature_question",
  "other",
]);

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function normalizeIssueType(value: string): SupportIssueType | null {
  const normalized = value.trim() as SupportIssueType;
  return ISSUE_TYPES.has(normalized) ? normalized : null;
}

function redirectSupportWithMessage(
  kind: "success" | "error",
  message: string
): never {
  const params = new URLSearchParams({
    [kind]: message,
  });

  redirect(`/app/support?${params.toString()}`);
}

function isNextRedirectError(error: unknown): error is { digest: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest?: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

export async function submitSupportRequestAction(formData: FormData) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      redirect("/login");
    }

    const context = await getCurrentStudioContext();

    const issueType = normalizeIssueType(getString(formData, "issueType"));
    const subject = getString(formData, "subject");
    const description = getString(formData, "description");

    if (!issueType) {
      redirectSupportWithMessage("error", "Please choose the type of help you need.");
    }

    if (!subject) {
      redirectSupportWithMessage("error", "Please add a short subject.");
    }

    if (!description) {
      redirectSupportWithMessage("error", "Please describe the problem or question.");
    }

    const { error } = await supabase.from("support_requests").insert({
      studio_id: context?.studioId ?? null,
      user_id: user.id,
      user_role: context?.studioRole ?? null,
      issue_type: issueType,
      subject,
      description,
      status: "open",
    });

    if (error) {
      redirectSupportWithMessage(
        "error",
        `Could not send your support request: ${error.message}`
      );
    }

    revalidatePath("/app/support");
    redirectSupportWithMessage(
      "success",
      "Your support request was sent. We’ll review it and follow up as soon as we can."
    );
  } catch (error) {
    if (isNextRedirectError(error)) {
      throw error;
    }

    redirectSupportWithMessage(
      "error",
      error instanceof Error ? error.message : "Something went wrong."
    );
  }
}