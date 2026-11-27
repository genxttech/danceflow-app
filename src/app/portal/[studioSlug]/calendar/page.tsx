import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { feedsEnabledForStudio, getFeedStatus } from "@/lib/calendar-feeds/service";
import { resolveDancerProfiles } from "@/lib/calendar-feeds/authz";
import FeedPanel from "@/components/calendar-feeds/FeedPanel";
import { createOrRotateDancerFeedAction, revokeDancerFeedAction, updateDancerFeedAction } from "./actions";

type Params = Promise<{ studioSlug: string }>;

export default async function PortalCalendarPage({ params }: { params: Params }) {
  const { studioSlug } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?intent=public&next=/portal/${encodeURIComponent(studioSlug)}/calendar`);

  const admin = createAdminClient();
  const { data: studio } = await admin.from("studios").select("id, name, public_name").eq("slug", studioSlug).maybeSingle();
  if (!studio) notFound();
  // Dark feature: the page does not exist unless the env flag AND this studio's switch are on.
  if (!(await feedsEnabledForStudio(admin, studio.id))) notFound();

  const profiles = await resolveDancerProfiles(admin, studio.id, user.id);
  if (!profiles.length) redirect(`/portal/${encodeURIComponent(studioSlug)}`);
  const status = await getFeedStatus(admin, studio.id, "dancer_account", user.id);

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">{studio.public_name?.trim() || studio.name}</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">Calendar subscription</h1>
      </header>
      <FeedPanel
        audience="dancer"
        hidden={{ studioSlug }}
        status={status}
        profiles={profiles}
        createAction={createOrRotateDancerFeedAction}
        revokeAction={revokeDancerFeedAction}
        updateAction={updateDancerFeedAction}
      />
    </div>
  );
}
