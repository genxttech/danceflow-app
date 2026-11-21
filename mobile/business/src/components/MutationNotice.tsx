import { StyleSheet, View } from "react-native";
import { Announce } from "@/components/Announce";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import type { MutationFailure, MutationFailureKind, MutationState } from "@/lib/mutation";
import { colors, radius, space } from "@/theme";

/** Words for each way a write can fail. Each says what happened to the change, and what the person can do. */
export function mutationFailureCopy(failure: Pick<MutationFailure, "kind" | "unconfirmed" | "retryAfterSeconds"> & { conflict?: MutationFailure["conflict"] }): { title: string; body: string } {
  const byCode = failure.kind === "conflict" ? CONFLICT_COPY[failure.conflict?.serverCode ?? ""] : undefined;
  if (byCode) return byCode;
  const wait = failure.retryAfterSeconds ? ` Wait about ${failure.retryAfterSeconds} seconds.` : "";
  const table: Record<MutationFailureKind, { title: string; body: string }> = {
    sync_pending: { title: "Saved, not finished", body: "The change was recorded, but the lesson credit has not been applied yet. Try again to finish it: nothing will be counted twice." },
    offline: { title: "Not confirmed", body: "No connection, so we can't tell if this was saved. Try again: it will not be saved twice." },
    timeout: { title: "Not confirmed", body: "This is taking too long, so we can't tell if it was saved. Try again: it will not be saved twice." },
    unavailable: failure.unconfirmed
      ? { title: "Not confirmed", body: "DanceFlow gave an unexpected answer, so we can't tell if this was saved. Try again: it will not be saved twice." }
      : { title: "Not saved", body: "DanceFlow is temporarily unavailable. Nothing was changed. Try again in a moment." },
    rate_limited: { title: "Not saved", body: `Too many requests right now. Nothing was changed.${wait}` },
    conflict: { title: "This changed while you were editing", body: "Someone else changed this. Refresh to see the latest, then try again." },
    writes_disabled: { title: "This change is turned off", body: "Making this change is turned off right now. You can still look things up. Try again later." },
    upgrade_required: { title: "Update DanceFlow Business", body: "This change needs a newer version of the app. Update it from Google Play, then try again." },
    sign_in_again: { title: "Sign in again", body: "Your session has ended. Nothing was changed. Sign in again, then retry." },
    account_inactive: { title: "This account is not active", body: "Nothing was changed. Contact your studio if you think this is a mistake." },
    platform_admin: { title: "Use DanceFlow on the web", body: "Platform admin accounts are not supported in this app. Nothing was changed." },
    no_access: { title: "No access to this studio", body: "Your access changed. Nothing was changed. Ask the studio owner if you need it back." },
    paused: { title: "This studio is paused", body: "The studio's subscription needs attention. Nothing was changed." },
    not_permitted: { title: "Not available for your role", body: "Your role at this studio does not include this change. Nothing was changed." },
    not_found: { title: "Not found", body: "This is gone, moved, or is not yours to change. Nothing was changed." },
    not_markable: { title: "Can't be changed now", body: "This can't be changed right now. Nothing was changed." },
    client_bug: { title: "Something went wrong", body: "The app sent a request DanceFlow could not read. Nothing was changed. Update the app if it keeps happening." },
  };
  return table[failure.kind];
}

/** Words for 409 conflicts the server names, so a screen need not repeat them. Anything else uses the generic conflict copy. */
const CONFLICT_COPY: Record<string, { title: string; body: string }> = {
  outcome_conflict: { title: "Already recorded", body: "This lesson already has a final attendance (attended or no-show). It can't be changed in the app." },
  payment_required: { title: "Payment needed first", body: "This lesson can't be marked attended until it's paid or covered by a package or membership. Take care of that on DanceFlow for the web, then mark it." },
  charge_failed: { title: "No-show saved, charge not applied", body: "The no-show was recorded, but the lesson credit could not be used. Fix it on DanceFlow for the web." },
  idempotency_conflict: { title: "Not saved", body: "That id was already used for something different. Nothing was changed. Start again." },
  duplicate_client: { title: "This client may already exist", body: "A client with these details is already in your studio." },
};

type Props = {
  state: MutationState<unknown>;
  onRetry: () => void;
  /** Gives up on an unconfirmed change: rolls back what the screen is showing. */
  onDiscard: () => void;
  /** Hides a refusal that already rolled back. */
  onDismiss: () => void;
  /** Conflict: re-reads the screen's data. */
  onRefresh?: () => void;
  onSignInAgain?: () => void;
  testID?: string;
};

/** Inline status for a mutation: "Saving…", or the failure with its recovery. Renders nothing for idle and success (the screen shows its own result). */
export function MutationNotice({ state, onRetry, onDiscard, onDismiss, onRefresh, onSignInAgain, testID = "mutation-notice" }: Props) {
  if (state.status === "idle" || state.status === "success") return null;

  if (state.status === "pending") {
    return (
      <AppText tone="muted" accessibilityLiveRegion="polite" testID={`${testID}-saving`}>
        Saving…
      </AppText>
    );
  }

  const copy = mutationFailureCopy(state);
  const actions: { label: string; onPress: () => void; variant?: "primary" | "secondary" | "quiet" }[] = [];
  if (state.retryable) actions.push({ label: state.unconfirmed ? "Try again" : "Retry", onPress: onRetry });
  // sync_pending: the change IS recorded, so there is nothing to discard
  if (state.unconfirmed && state.kind !== "sync_pending") actions.push({ label: "Discard this change", onPress: onDiscard, variant: "quiet" });
  if (state.kind === "conflict" && onRefresh) actions.push({ label: "Refresh", onPress: onRefresh });
  if ((state.kind === "sign_in_again" || state.kind === "account_inactive" || state.kind === "platform_admin") && onSignInAgain) {
    actions.push({ label: state.kind === "sign_in_again" ? "Sign in again" : "Sign out", onPress: onSignInAgain });
  }
  if (!state.unconfirmed || state.kind === "sync_pending") actions.push({ label: "Dismiss", onPress: onDismiss, variant: "quiet" });

  return (
    <View style={styles.card} accessibilityRole="alert" testID={testID}>
      <Announce message={`${copy.title}. ${copy.body}`} />
      <AppText variant="lead" accessibilityRole="header">
        {copy.title}
      </AppText>
      <AppText tone="muted">{copy.body}</AppText>
      <View style={styles.actions}>
        {actions.map((action) => (
          <AppButton key={action.label} label={action.label} onPress={action.onPress} variant={action.variant ?? "secondary"} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm, padding: space.lg, borderRadius: radius.row, borderWidth: 1, borderLeftWidth: 4, borderColor: colors.error, backgroundColor: colors.raised },
  actions: { gap: space.sm, marginTop: space.xs },
});
