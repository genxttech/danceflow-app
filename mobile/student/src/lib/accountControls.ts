import { danceflowApiFetch } from "@/lib/danceflowApi";

export async function leaveConnectedStudio(params: {
  linkId: string;
  studioId: string;
  reason?: string;
}) {
  return danceflowApiFetch<{ ok: true }>("/api/student/studio-links/leave", {
    method: "POST",
    body: JSON.stringify({
      linkId: params.linkId,
      studioId: params.studioId,
      confirmation: "LEAVE",
      reason: params.reason ?? "",
    }),
  });
}

export async function deleteDanceFlowAccount() {
  return danceflowApiFetch<{
    deleted: true;
    preservedStudioRelationshipCount: number;
  }>("/api/student/account", {
    method: "DELETE",
    body: JSON.stringify({ confirmation: "DELETE" }),
  });
}
