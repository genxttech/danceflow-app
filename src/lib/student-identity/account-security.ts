import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

export type DanceFlowAccountStatus =
  | "active"
  | "deactivated"
  | "pending_deletion";

function cleanReason(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 500);
}

export function normalizeAccountEmail(value: unknown) {
  const email =
    typeof value === "string" ? value.trim().toLowerCase().slice(0, 254) : "";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid email address.");
  }

  return email;
}

export async function getDanceFlowAccountStatus(userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("user_account_status")
    .select("status, deactivated_at, reactivated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Account status lookup failed: ${error.message}`);
  }

  return {
    status: (data?.status ?? "active") as DanceFlowAccountStatus,
    deactivatedAt: data?.deactivated_at ?? null,
    reactivatedAt: data?.reactivated_at ?? null,
  };
}

export async function deactivateDanceFlowAccount(params: {
  user: User;
  reason?: string | null;
}) {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const reason =
    cleanReason(params.reason) ||
    "Account deactivated by the account owner.";

  const { error } = await admin.from("user_account_status").upsert(
    {
      user_id: params.user.id,
      status: "deactivated",
      deactivated_at: now,
      reactivated_at: null,
      deactivation_reason: reason,
      updated_at: now,
    },
    { onConflict: "user_id" },
  );

  if (error) {
    throw new Error(`Account deactivation failed: ${error.message}`);
  }

  await admin
    .from("dancer_profiles")
    .update({
      profile_visibility: "private",
      updated_at: now,
    })
    .eq("user_id", params.user.id);

  return { deactivated: true as const, deactivatedAt: now };
}

export async function reactivateDanceFlowAccount(user: User) {
  const current = await getDanceFlowAccountStatus(user.id);

  if (current.status === "pending_deletion") {
    throw new Error("Account deletion is in progress.");
  }

  if (current.status === "active") {
    return {
      active: true as const,
      reactivatedAt: current.reactivatedAt,
      changed: false as const,
    };
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { error } = await admin.from("user_account_status").upsert(
    {
      user_id: user.id,
      status: "active",
      reactivated_at: now,
      deactivation_reason: null,
      updated_at: now,
    },
    { onConflict: "user_id" },
  );

  if (error) {
    throw new Error(`Account reactivation failed: ${error.message}`);
  }

  return {
    active: true as const,
    reactivatedAt: now,
    changed: true as const,
  };
}
