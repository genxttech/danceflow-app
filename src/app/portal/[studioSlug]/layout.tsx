import type { ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type PortalStudioLayoutProps = {
  children: ReactNode;
  params: Promise<{
    studioSlug: string;
  }>;
};

type StudioRow = {
  id: string;
  name: string;
  slug: string;
  public_name?: string | null;
  city?: string | null;
  state?: string | null;
};

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  is_independent_instructor: boolean | null;
};

function getDisplayName(client: ClientRow) {
  const full = `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim();
  return full || "Portal Member";
}

export default async function PortalStudioLayout({
  children,
  params,
}: PortalStudioLayoutProps) {
  const { studioSlug } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, name, slug, public_name, city, state")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    redirect("/login");
  }

  const typedStudio = studio as StudioRow;

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, is_independent_instructor")
    .eq("studio_id", typedStudio.id)
    .eq("portal_user_id", user.id)
    .single();

  if (clientError || !client) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const typedClient = client as ClientRow;
  const displayName = getDisplayName(typedClient);
  const isIndependentInstructor = Boolean(typedClient.is_independent_instructor);

  const basePortalHref = `/portal/${encodeURIComponent(typedStudio.slug)}`;
  const studioLabel = typedStudio.public_name?.trim() || typedStudio.name;
  const studioLocation =
    [typedStudio.city, typedStudio.state].filter(Boolean).join(", ") || null;

  const navItems = isIndependentInstructor
    ? [
        { href: basePortalHref, label: "Portal Home" },
        { href: `${basePortalHref}/schedule`, label: "My Schedule" },
        { href: `${basePortalHref}/floor-space`, label: "Book Floor Space" },
        { href: `${basePortalHref}/floor-space/my-rentals`, label: "My Rentals" },
        { href: `${basePortalHref}/profile`, label: "Profile" },
        { href: `${basePortalHref}/membership`, label: "Membership" },
      ]
    : [
        { href: basePortalHref, label: "Portal Home" },
        { href: `${basePortalHref}/profile`, label: "Profile" },
        { href: `${basePortalHref}/membership`, label: "Membership" },
      ];

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#f8fafc_0%,#ffffff_28%,#f8fafc_100%)]">
      <header className="border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 lg:px-8">
          <div className="overflow-hidden rounded-[32px] border border-slate-200 bg-[linear-gradient(135deg,#0d1536_0%,#111b45_48%,#5b145e_100%)] text-white shadow-sm">
            <div className="grid gap-6 p-6 sm:p-8 lg:grid-cols-[1.25fr_0.75fr]">
              <div>
                <div className="flex items-center gap-4">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/15">
                    <Image
                      src="/brand/danceflow-logo.png"
                      alt="DanceFlow"
                      width={42}
                      height={42}
                      className="h-10 w-10 object-contain"
                      priority
                    />
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                      DanceFlow Portal
                    </p>
                    <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
                      {studioLabel}
                    </h1>
                    {studioLocation ? (
                      <p className="mt-1 text-sm text-white/75">{studioLocation}</p>
                    ) : null}
                  </div>
                </div>

                <p className="mt-5 max-w-2xl text-sm leading-7 text-white/80 sm:text-base">
                  {isIndependentInstructor
                    ? "Your instructor portal gives you a focused workspace for your schedule, floor rentals, studio access, and any linked client membership tools."
                    : "Your studio portal gives you quick access to lessons, memberships, and studio-specific account tools while your favorites and public registrations remain in your main account."}
                </p>

                <div className="mt-6 flex flex-wrap gap-3">
                  <span className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white/90 ring-1 ring-white/15">
                    Signed in as {displayName}
                  </span>

                  <span className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white/90 ring-1 ring-white/15">
                    {isIndependentInstructor
                      ? "Independent Instructor Access"
                      : "Client Portal Access"}
                  </span>
                </div>
              </div>

              <div className="rounded-[28px] border border-white/12 bg-white/8 p-5 backdrop-blur-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">
                  Quick Actions
                </p>

                <div className="mt-4 grid gap-3">
                  <Link
                    href="/account"
                    className="rounded-2xl bg-white px-4 py-3 text-sm font-medium text-slate-900 transition hover:bg-slate-100"
                  >
                    My Account
                  </Link>

                  <Link
                    href={basePortalHref}
                    className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3 text-sm font-medium text-white transition hover:bg-white/15"
                  >
                    Portal Home
                  </Link>

                  {isIndependentInstructor ? (
                    <>
                      <Link
                        href={`${basePortalHref}/schedule`}
                        className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3 text-sm font-medium text-white transition hover:bg-white/15"
                      >
                        My Schedule
                      </Link>

                      <Link
                        href={`${basePortalHref}/floor-space`}
                        className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3 text-sm font-medium text-white transition hover:bg-white/15"
                      >
                        Book Floor Space
                      </Link>

                      <Link
                        href={`${basePortalHref}/floor-space/my-rentals`}
                        className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3 text-sm font-medium text-white transition hover:bg-white/15"
                      >
                        My Rentals
                      </Link>
                    </>
                  ) : null}

                  <form action="/auth/logout" method="post">
                    <button
                      type="submit"
                      className="w-full rounded-2xl border border-white/15 bg-white/10 px-4 py-3 text-left text-sm font-medium text-white transition hover:bg-white/15"
                    >
                      Log Out
                    </button>
                  </form>
                </div>
              </div>
            </div>
          </div>

          <nav className="mt-4 flex flex-wrap gap-2">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}