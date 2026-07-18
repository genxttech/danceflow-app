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


export async function requestLoginEmailChange(email: string) {
  return danceflowApiFetch<{
    requested: true;
    email: string;
    message: string;
  }>("/api/student/account/email", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function deactivateDanceFlowAccount(reason = "") {
  return danceflowApiFetch<{
    deactivated: true;
    deactivatedAt: string;
  }>("/api/student/account/deactivate", {
    method: "POST",
    body: JSON.stringify({
      confirmation: "DEACTIVATE",
      reason,
    }),
  });
}

export async function reactivateDanceFlowAccount() {
  return danceflowApiFetch<{
    active: true;
    reactivatedAt: string;
  }>("/api/student/account/reactivate", {
    method: "POST",
    body: JSON.stringify({}),
  });
}
