import { StateMessage } from "@/components/StateMessage";
import { staffErrorKind, type StaffErrorKind } from "@/lib/staffApi";

type Props = {
  error: unknown;
  onRetry: () => void;
  onSignInAgain: () => void;
  /** Re-reads /me, used after not_a_member so the workspace list is current. */
  onRefreshWorkspaces?: () => void;
};

type Copy = { title: string; body: string; testID: string };

const COPY: Record<StaffErrorKind, Copy> = {
  sign_in_again: {
    title: "Sign in again",
    body: "Your session has ended. Sign in again to see your schedule.",
    testID: "error-sign-in-again",
  },
  account_inactive: {
    title: "This account is not active",
    body: "Your DanceFlow account is deactivated or pending deletion. Contact your studio if you think this is a mistake.",
    testID: "error-account-inactive",
  },
  platform_admin: {
    title: "Use DanceFlow on the web",
    body: "Platform admin accounts are not supported in DanceFlow Business yet. Sign in on the web instead.",
    testID: "error-platform-admin",
  },
  no_access: {
    title: "No access to this studio",
    body: "You are no longer a member of this studio, or your access changed. Ask the studio owner if you need it back.",
    testID: "error-no-access",
  },
  paused: {
    title: "This studio is paused",
    body: "The studio's subscription needs attention. The owner can resolve billing on the web.",
    testID: "error-paused",
  },
  not_permitted: {
    title: "Not available for your role",
    body: "Your role at this studio does not include this feature.",
    testID: "error-not-permitted",
  },
  not_found: {
    title: "Not found",
    body: "This appointment is gone, moved, or is not yours to view.",
    testID: "error-not-found",
  },
  unavailable: {
    title: "Temporarily unavailable",
    body: "DanceFlow could not load this right now. Check your connection and try again in a moment.",
    testID: "error-unavailable",
  },
  client_bug: {
    title: "Something went wrong",
    body: "The app sent a request DanceFlow could not read. Try again, and update the app if it keeps happening.",
    testID: "error-client-bug",
  },
};

export function StaffErrorState({ error, onRetry, onSignInAgain, onRefreshWorkspaces }: Props) {
  const kind = staffErrorKind(error);
  const copy = COPY[kind];

  const actions = (() => {
    switch (kind) {
      case "sign_in_again":
      case "account_inactive":
      case "platform_admin":
        return [{ label: kind === "sign_in_again" ? "Sign in again" : "Sign out", onPress: onSignInAgain }];
      case "no_access":
      case "paused":
      case "not_permitted":
        return onRefreshWorkspaces ? [{ label: "Refresh studios", onPress: onRefreshWorkspaces, variant: "secondary" as const }] : [];
      default:
        return [{ label: "Try again", onPress: onRetry }];
    }
  })();

  return <StateMessage tone="error" title={copy.title} body={copy.body} testID={copy.testID} actions={actions} />;
}
