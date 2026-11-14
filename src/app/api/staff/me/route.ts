import { staffCapabilitiesForRole } from "@/lib/auth/staffCapabilities";
import {
  requireStaffApiUser,
  staffApiJson,
  staffApiUnavailable,
} from "@/lib/auth/staffApiAuth";
import { getWorkspacesForUserWithClient, isWorkspaceAccessAllowedStatus } from "@/lib/auth/studio";
import { resolveStudioTimeZone } from "@/lib/staff/instructorToday";

type StudioStatusRow = { id: string; subscription_status: string | null; timezone: string | null };

export async function GET(request: Request) {
  const guard = await requireStaffApiUser(request);
  if (!guard.ok) return guard.response;

  const { user, supabase, fullName } = guard;

  try {
    const workspaces = (await getWorkspacesForUserWithClient(user.id, supabase as never)).filter(
      (workspace) => workspace.role !== "platform_admin",
    );

    let studioById = new Map<string, StudioStatusRow>();
    if (workspaces.length > 0) {
      const { data, error } = await supabase
        .from("studios")
        .select("id, subscription_status, timezone")
        .in(
          "id",
          workspaces.map((workspace) => workspace.studioId),
        );
      if (error) throw new Error(`Workspace status lookup failed: ${error.message}`);
      studioById = new Map(((data ?? []) as StudioStatusRow[]).map((row) => [row.id, row]));
    }

    return staffApiJson({
      user: { id: user.id, email: user.email ?? null, fullName },
      workspaces: workspaces.map((workspace) => {
        const studio = studioById.get(workspace.studioId);
        const subscriptionStatus = studio?.subscription_status ?? null;
        return {
          studioId: workspace.studioId,
          name: workspace.studioName,
          publicName: workspace.studioPublicName,
          slug: workspace.studioSlug,
          role: workspace.role,
          timeZone: resolveStudioTimeZone(studio?.timezone),
          accessAllowed: isWorkspaceAccessAllowedStatus(subscriptionStatus),
          subscriptionStatus,
          capabilities: staffCapabilitiesForRole(workspace.role),
        };
      }),
    });
  } catch (failure) {
    return staffApiUnavailable(new URL(request.url).pathname, failure);
  }
}
