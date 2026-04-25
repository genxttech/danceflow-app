import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

type InvitePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getString(
  value: string | string[] | undefined,
  fallback = ""
) {
  if (typeof value === "string") return value;
  return fallback;
}

function roleLabel(role: string) {
  if (role === "studio_admin") return "Studio Manager";

  return role
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export default async function InvitePage({ searchParams }: InvitePageProps) {
  const resolvedSearchParams = (await searchParams) ?? {};

  const email = getString(resolvedSearchParams.email);
  const next = getString(resolvedSearchParams.next, "/app");

  const loginHref = `/login?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`;
  const signupHref = `/signup?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`;

  const supabase = await createClient();

  let workspaceSummaries: Array<{
    studioId: string;
    studioName: string;
    role: string;
  }> = [];

  if (email) {
    const { data: invitations } = await supabase
      .from("team_invitations")
      .select("studio_id, role, accepted_at, revoked_at, expires_at")
      .eq("email", email.toLowerCase())
      .is("accepted_at", null)
      .is("revoked_at", null)
      .order("created_at", { ascending: false });

    const activeInvitations =
      invitations?.filter((invite) => {
        if (!invite.expires_at) return true;
        return new Date(invite.expires_at) >= new Date();
      }) ?? [];

    const studioIds = [...new Set(activeInvitations.map((invite) => invite.studio_id))];

    let studioNameMap = new Map<string, string>();

    if (studioIds.length > 0) {
      const { data: studios } = await supabase
        .from("studios")
        .select("id, name")
        .in("id", studioIds);

      studioNameMap = new Map(
        (studios ?? []).map((studio) => [studio.id as string, (studio.name as string) ?? "Workspace"])
      );
    }

    workspaceSummaries = activeInvitations.map((invite) => ({
      studioId: invite.studio_id as string,
      studioName: studioNameMap.get(invite.studio_id as string) ?? "Workspace",
      role: invite.role as string,
    }));
  }

  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,#faf5ff_0%,#ffffff_28%)] px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
          <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-10 text-white md:px-8">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
              DanceFlow Staff Access
            </p>

            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
              You’ve been invited to join a workspace
            </h1>

            <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
              Use your secure staff login to access the workspace you were invited to.
              Your permissions and access level will be applied automatically after sign in.
            </p>
          </div>

          <div className="space-y-6 px-6 py-8 md:px-8">
            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
              <p className="text-sm font-medium text-slate-700">Invited email</p>
              <p className="mt-2 break-all text-lg font-semibold text-slate-950">
                {email || "No email provided"}
              </p>
              <p className="mt-2 text-sm leading-7 text-slate-500">
                Sign in with this email, or create your secure staff login with this same email
                to activate your workspace access.
              </p>
            </div>

            {workspaceSummaries.length > 0 ? (
              <div className="rounded-3xl border border-slate-200 bg-white p-5">
                <h2 className="text-lg font-semibold text-slate-950">Pending workspace access</h2>
                <div className="mt-4 space-y-3">
                  {workspaceSummaries.map((workspace, index) => (
                    <div
                      key={`${workspace.studioId}-${workspace.role}-${index}`}
                      className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                    >
                      <p className="text-base font-semibold text-slate-950">
                        {workspace.studioName}
                      </p>
                      <p className="mt-1 text-sm text-slate-500">
                        Role: {roleLabel(workspace.role)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-3xl border border-amber-200 bg-amber-50 p-5">
                <h2 className="text-lg font-semibold text-amber-900">Invitation not found</h2>
                <p className="mt-2 text-sm leading-7 text-amber-800">
                  We could not find an active pending invitation for this email. Double-check that
                  you opened the latest invite link and use the same email address when signing in.
                </p>
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <Link
                href={loginHref}
                className="rounded-2xl bg-violet-600 px-5 py-4 text-center text-sm font-medium text-white shadow-sm hover:bg-violet-700"
              >
                Sign In to Activate Access
              </Link>

              <Link
                href={signupHref}
                className="rounded-2xl border border-slate-300 bg-white px-5 py-4 text-center text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
              >
                Create Staff Login
              </Link>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5">
              <h2 className="text-lg font-semibold text-slate-950">What happens next</h2>
              <div className="mt-4 space-y-3 text-sm leading-7 text-slate-600">
                <p>1. Sign in or create your login using the invited email.</p>
                <p>2. Your invitation is matched automatically after authentication.</p>
                <p>3. Your workspace access and role permissions are applied.</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}