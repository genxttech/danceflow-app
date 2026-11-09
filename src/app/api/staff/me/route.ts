import { staffCapabilitiesForRole } from "@/lib/auth/staffCapabilities";
import {
  requireStaffApiUser,
  staffApiJson,
  staffApiUnavailable,
} from "@/lib/auth/staffApiAuth";
import { getWorkspacesForUserWithClient, isWorkspaceAccessAllowedStatus } from "@/lib/auth/studio";

type StudioStatusRow = { id: string; subscription_status: string | null };

export async function GET(request: Request) {
  const guard = await requireStaffApiUser(request);
  if (!guard.ok) return guard.response;

  const { user, supabase, fullName } = guard;

  try {
    const workspaces = (await getWorkspacesForUserWithClient(user.id, supabase as never)).filter(
      (workspace) => workspace.role !== "platform_admin",
    );

    let statusByStudio = new Map<string, string | null>();
    if (workspaces.length > 0) {
      const { data, error } = await supabase
        .from("studios")
        .select("id, subscription_status")
        .in(
          "id",
          workspaces.map((workspace) => workspace.studioId),
        );
      if (error) throw new Error(`Workspace status lookup failed: ${error.message}`);
      statusByStudio = new Map(
        ((data ?? []) as StudioStatusRow[]).map((row) => [row.id, row.subscription_status]),
      );
    }

    return staffApiJson({
      user: { id: user.id, email: user.email ?? null, fullName },
      workspaces: workspaces.map((workspace) => {
        const subscriptionStatus = statusByStudio.get(workspace.studioId) ?? null;
        return {
          studioId: workspace.studioId,
          name: workspace.studioName,
          publicName: workspace.studioPublicName,
          slug: workspace.studioSlug,
          role: workspace.role,
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
