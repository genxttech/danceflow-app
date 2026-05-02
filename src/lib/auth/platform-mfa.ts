import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type MfaFactor = {
  id: string;
  status?: string | null;
  factor_type?: string | null;
  friendly_name?: string | null;
  created_at?: string | null;
};

type PlatformMfaStatus = {
  currentLevel: string | null;
  nextLevel: string | null;
  hasVerifiedTotpFactor: boolean;
  verifiedTotpFactors: MfaFactor[];
};

function getVerifiedTotpFactors(factorsData: unknown): MfaFactor[] {
  const factors = factorsData as
    | {
        totp?: MfaFactor[];
        all?: MfaFactor[];
      }
    | null
    | undefined;

  const totpFactors = Array.isArray(factors?.totp)
    ? factors.totp
    : Array.isArray(factors?.all)
      ? factors.all.filter((factor) => factor.factor_type === "totp")
      : [];

  return totpFactors.filter((factor) => factor.status === "verified");
}

export async function getPlatformMfaStatus(): Promise<PlatformMfaStatus> {
  const supabase = await createClient();

  const [{ data: aalData, error: aalError }, { data: factorsData, error: factorsError }] =
    await Promise.all([
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      supabase.auth.mfa.listFactors(),
    ]);

  if (aalError) {
    throw new Error(`Could not check MFA assurance level: ${aalError.message}`);
  }

  if (factorsError) {
    throw new Error(`Could not check MFA factors: ${factorsError.message}`);
  }

  const verifiedTotpFactors = getVerifiedTotpFactors(factorsData);

  return {
    currentLevel: aalData?.currentLevel ?? null,
    nextLevel: aalData?.nextLevel ?? null,
    hasVerifiedTotpFactor: verifiedTotpFactors.length > 0,
    verifiedTotpFactors,
  };
}

export async function requirePlatformMfa() {
  const status = await getPlatformMfaStatus();

  if (!status.hasVerifiedTotpFactor) {
    redirect("/platform-mfa/setup");
  }

  if (status.currentLevel !== "aal2") {
    redirect("/platform-mfa/challenge");
  }

  return status;
}
