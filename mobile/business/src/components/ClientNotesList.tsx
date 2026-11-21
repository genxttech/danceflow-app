import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { useStaffApi } from "@/lib/staff";
import type { ClientNoteEntry } from "@/lib/staffApi";
import { staffErrorKind } from "@/lib/staffApi";
import { colors, radius, space } from "@/theme";

const TYPE_LABELS: Record<string, string> = {
  general: "General",
  follow_up: "Follow-up",
  sales: "Sales",
  lesson: "Lesson",
  billing: "Billing",
  concern: "Concern",
};

const PAGE = 20;

export function noteDate(iso: string, timeZone: string | null | undefined) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: timeZone ?? undefined }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
  }
}

type State =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; notes: ClientNoteEntry[]; nextCursor: string | null; loadingMore: boolean; moreError: boolean };

/**
 * A client's notes, newest first, paged. `reloadKey` changes after a note is saved so the list re-reads from the top (the server pages by keyset, so a new note
 * never duplicates or skips one already on screen). A read failure here never hides the rest of the client; it says so in words with a retry.
 */
export function ClientNotesList({ studioId, clientId, timeZone, reloadKey }: { studioId: string; clientId: string; timeZone?: string | null; reloadKey: number }) {
  const api = useStaffApi();
  const [state, setState] = useState<State>({ status: "loading" });
  const request = useRef(0);

  // The effect only sets state in promise callbacks (never synchronously), ignoring an answer that arrives after unmount or after the inputs change.
  useEffect(() => {
    const id = ++request.current;
    api.clientNotes(studioId, clientId, { limit: PAGE }).then(
      (page) => {
        if (id === request.current) setState({ status: "ready", notes: page.notes, nextCursor: page.nextCursor, loadingMore: false, moreError: false });
      },
      (error: unknown) => {
        if (id === request.current) setState({ status: "error", error });
      },
    );
    return () => {
      request.current += 1;
    };
  }, [api, studioId, clientId, reloadKey]);

  /** Retry after an error: show loading, then read again. */
  const load = useCallback(async () => {
    const id = ++request.current;
    setState({ status: "loading" });
    try {
      const page = await api.clientNotes(studioId, clientId, { limit: PAGE });
      if (id === request.current) setState({ status: "ready", notes: page.notes, nextCursor: page.nextCursor, loadingMore: false, moreError: false });
    } catch (error) {
      if (id === request.current) setState({ status: "error", error });
    }
  }, [api, studioId, clientId]);

  async function more(cursor: string) {
    const id = request.current;
    setState((s) => (s.status === "ready" ? { ...s, loadingMore: true, moreError: false } : s));
    try {
      const page = await api.clientNotes(studioId, clientId, { cursor, limit: PAGE });
      if (id !== request.current) return;
      setState((s) =>
        s.status === "ready"
          ? { ...s, notes: [...s.notes, ...page.notes.filter((n) => !s.notes.some((seen) => seen.id === n.id))], nextCursor: page.nextCursor, loadingMore: false }
          : s,
      );
    } catch {
      if (id === request.current) setState((s) => (s.status === "ready" ? { ...s, loadingMore: false, moreError: true } : s));
    }
  }

  if (state.status === "loading") {
    return (
      <AppText tone="muted" accessibilityLiveRegion="polite" testID="notes-loading">
        Loading notes…
      </AppText>
    );
  }

  if (state.status === "error") {
    const kind = staffErrorKind(state.error);
    return (
      <View style={styles.gap} testID="notes-error">
        <AppText tone="error" accessibilityRole="alert">
          {kind === "not_permitted" || kind === "no_access" ? "Your role can't read notes." : "Notes couldn't be loaded."}
        </AppText>
        {kind === "not_permitted" || kind === "no_access" ? null : <AppButton label="Try loading notes again" variant="secondary" onPress={() => void load()} />}
      </View>
    );
  }

  if (state.notes.length === 0) {
    return (
      <AppText tone="muted" testID="notes-empty">
        No notes yet.
      </AppText>
    );
  }

  return (
    <View style={styles.gap} testID="notes-list">
      {state.notes.map((note) => (
        <View key={note.id} style={styles.note} accessible accessibilityLabel={`${TYPE_LABELS[note.noteType] ?? "Note"}, ${noteDate(note.occurredAt, timeZone)}, by ${note.isMine ? "you" : note.authorName ?? "staff"}. ${note.body}`} testID={`note-${note.id}`}>
          <AppText variant="caption" tone="muted">
            {TYPE_LABELS[note.noteType] ?? "Note"} · {noteDate(note.occurredAt, timeZone)} · {note.isMine ? "You" : note.authorName ?? "Staff"}
          </AppText>
          <AppText>{note.body}</AppText>
        </View>
      ))}
      {state.moreError ? (
        <AppText tone="error" accessibilityRole="alert">
          More notes couldn&apos;t be loaded.
        </AppText>
      ) : null}
      {state.nextCursor ? <AppButton label="Show older notes" variant="secondary" loading={state.loadingMore} onPress={() => void more(state.nextCursor!)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: space.sm },
  note: { gap: 2, padding: space.md, borderRadius: radius.row, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
});
