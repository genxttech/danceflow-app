import { danceflowApiFetch } from "@/lib/danceflowApi";

export async function leaveConnectedStudio(params: {
  studioId: string;
  reason?: string;
}) {
  return danceflowApiFetch<{ ok: true }>("/api/student/studio-links/leave", {
    method: "POST",
    body: JSON.stringify({
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
