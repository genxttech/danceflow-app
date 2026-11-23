import { notFound } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageSettings } from "@/lib/auth/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { feedsEnabledForStudio, getFeedStatus, isActiveInstructor, listStaffFeeds } from "@/lib/calendar-feeds/service";
import FeedPanel from "@/components/calendar-feeds/FeedPanel";
import { adminRevokeAllFeedsAction, adminRevokeStaffFeedAction, createOrRotateStaffFeedAction, revokeStaffFeedAction, updateStaffFeedAction } from "./actions";

export default async function StaffCalendarFeedPage() {
  const context = await getCurrentStudioContext();
  const admin = createAdminClient();
  // Dark feature: hidden unless the env flag AND this studio's switch are on.
  if (!(await feedsEnabledForStudio(admin, context.studioId))) notFound();

  const isInstructor = await isActiveInstructor(admin, context.studioId, context.userId);
  const status = isInstructor ? await getFeedStatus(admin, context.studioId, "staff", context.userId) : null;
  const manager = canManageSettings(context.studioRole ?? "");
  const staffFeeds = manager ? await listStaffFeeds(admin, context.studioId) : [];

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-4">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Calendar subscription</h1>
        <p className="mt-1 text-sm text-slate-600">Add your DanceFlow teaching schedule to your own calendar app.</p>
      </header>

      {isInstructor ? (
        <FeedPanel
          audience="staff"
          hidden={{}}
          status={status}
          profiles={[]}
          createAction={createOrRotateStaffFeedAction}
          revokeAction={revokeStaffFeedAction}
          updateAction={updateStaffFeedAction}
        />
      ) : (
        <p className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-700">
          Your account is not linked to an active instructor profile in this studio, so there is no personal teaching schedule to subscribe to.
        </p>
      )}

      {manager ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-900">Staff calendar links</h2>
          <p className="mt-1 text-sm text-slate-600">You can turn a link off, but you cannot see or recover anyone&apos;s link.</p>
          {staffFeeds.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No staff calendar links are active.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {staffFeeds.map((feed) => (
                <li key={feed.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <span>
                    <span className="font-medium text-slate-900">{feed.name}</span>
                    <span className="ml-2 text-slate-500">
                      {feed.detailLevel === "standard" ? "student names shown" : "minimal"} · {feed.lastAccessedAt ? `last used ${new Date(feed.lastAccessedAt).toLocaleDateString()}` : "not used yet"}
                    </span>
                  </span>
                  <form action={adminRevokeStaffFeedAction}>
                    <input type="hidden" name="tokenId" value={feed.id} />
                    <input type="hidden" name="subjectUserId" value={feed.subjectUserId} />
                    <button type="submit" className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700">
                      Turn off
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <form action={adminRevokeAllFeedsAction} className="mt-4 border-t border-slate-100 pt-4">
            <button type="submit" className="rounded-xl border border-red-400 px-4 py-2 text-sm font-semibold text-red-800">
              Turn off all calendar links in this studio
            </button>
            <p className="mt-2 text-xs text-slate-500">Use this if a link may have been shared by mistake. Staff and dancers can create a new link afterwards.</p>
          </form>
        </section>
      ) : null}
    </div>
  );
}
