import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { router } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { ScheduleSkeleton } from "@/components/Skeleton";
import { StaffErrorState } from "@/components/StaffErrorState";
import { StateMessage } from "@/components/StateMessage";
import { isStaffFeatureEnabled } from "@/lib/features";
import { clientStatusLabel, personName } from "@/lib/format";
import { useStaffApi, useStaffSession } from "@/lib/staff";
import type { ClientSummary } from "@/lib/staffApi";
import { colors, radius, space, type } from "@/theme";

export const SEARCH_DEBOUNCE_MS = 300;
export const CLIENT_PAGE_SIZE = 25;

const LOOKUP_ERROR_COPY = {
  not_permitted: {
    title: "No access to client lookup",
    body: "Your role at this studio can't search clients. Ask the studio owner if you need it.",
  },
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; clients: ClientSummary[]; nextCursor: string | null; loadingMore: boolean; moreError: unknown };

function ClientRow({ client, onPress }: { client: ClientSummary; onPress: () => void }) {
  const name = personName({ id: client.id, firstName: client.firstName, lastName: client.lastName }) ?? "Client";
  const status = clientStatusLabel(client.status);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={status ? `${name}, ${status}` : name}
      accessibilityHint="Opens the client"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID={`client-${client.id}`}
    >
      <AppText variant="lead" style={styles.rowName}>
        {name}
      </AppText>
      {status ? (
        <AppText variant="caption" tone="muted">
          {status}
        </AppText>
      ) : null}
    </Pressable>
  );
}

function ClientLookup({ studioId, ownOnly }: { studioId: string; ownOnly: boolean }) {
  const api = useStaffApi();
  const { reload: reloadWorkspaces, signOut } = useStaffSession();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const requestId = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setState({ status: "loading" });
    try {
      const page = await api.searchClients(studioId, { q: debounced, limit: CLIENT_PAGE_SIZE });
      if (id === requestId.current) {
        setState({ status: "ready", clients: page.clients, nextCursor: page.nextCursor, loadingMore: false, moreError: null });
      }
    } catch (error) {
      if (id === requestId.current) setState({ status: "error", error });
    }
  }, [api, studioId, debounced]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (state.status !== "ready" || !state.nextCursor || state.loadingMore) return;
    const id = requestId.current;
    const cursor = state.nextCursor;
    setState({ ...state, loadingMore: true, moreError: null });
    try {
      const page = await api.searchClients(studioId, { q: debounced, cursor, limit: CLIENT_PAGE_SIZE });
      if (id !== requestId.current) return;
      setState((current) =>
        current.status === "ready"
          ? {
              status: "ready",
              // a client can move between pages while paging; never show a row twice
              clients: [...current.clients, ...page.clients.filter((c) => !current.clients.some((seen) => seen.id === c.id))],
              nextCursor: page.nextCursor,
              loadingMore: false,
              moreError: null,
            }
          : current,
      );
    } catch (error) {
      if (id === requestId.current) setState((current) => (current.status === "ready" ? { ...current, loadingMore: false, moreError: error } : current));
    }
  }

  return (
    <>
      <View style={styles.searchField}>
        <AppText variant="label" nativeID="client-search-label">
          Search clients
        </AppText>
        <TextInput
          accessibilityLabel="Search clients"
          accessibilityLabelledBy="client-search-label"
          accessibilityHint="Search by first or last name"
          autoCapitalize="words"
          autoCorrect={false}
          clearButtonMode="while-editing"
          onChangeText={setQuery}
          placeholder="Name"
          placeholderTextColor={colors.muted}
          returnKeyType="search"
          style={styles.input}
          testID="client-search"
          value={query}
        />
      </View>

      {state.status === "loading" ? <ScheduleSkeleton rows={5} label="Loading clients" /> : null}

      {state.status === "error" ? (
        <StaffErrorState
          error={state.error}
          onRetry={() => void load()}
          onSignInAgain={() => void signOut()}
          onRefreshWorkspaces={() => void reloadWorkspaces()}
          copy={LOOKUP_ERROR_COPY}
        />
      ) : null}

      {state.status === "ready" && state.clients.length === 0 ? (
        <StateMessage
          testID="clients-empty"
          title={debounced ? "No clients match" : "No clients yet"}
          body={
            debounced
              ? `${ownOnly ? "None of your clients" : "Nobody at this studio"} matches "${debounced}". Check the spelling or try a last name.`
              : ownOnly
                ? "Dancers booked into your lessons and classes appear here."
                : "Clients added on the web appear here."
          }
        />
      ) : null}

      {state.status === "ready" && state.clients.length > 0 ? (
        <View style={styles.list} testID="clients-list">
          {state.clients.map((client) => (
            <ClientRow
              key={client.id}
              client={client}
              onPress={() => router.push({ pathname: "/clients/[id]", params: { id: client.id, studioId } })}
            />
          ))}
          {state.moreError ? (
            <AppText tone="error" accessibilityRole="alert">
              More clients could not load. Try again.
            </AppText>
          ) : null}
          {state.nextCursor ? (
            <AppButton label="Load more clients" variant="secondary" onPress={() => void loadMore()} loading={state.loadingMore} />
          ) : null}
        </View>
      ) : null}
    </>
  );
}

export function ClientsScreen() {
  const { workspace } = useStaffSession();
  const studioWide = workspace?.capabilities?.viewClients === true;
  // The server scopes results by role: studio-wide for viewClients, own clients for instructors (schedule only).
  const ownOnly = !studioWide && workspace?.capabilities?.viewStudioSchedule === true;
  const lookup = (studioWide || ownOnly) && !!workspace && isStaffFeatureEnabled("clients");

  return (
    <Screen>
      <AppText variant="heading" accessibilityRole="header">
        {studioWide ? "Clients" : "My clients"}
      </AppText>
      {lookup && workspace ? (
        <ClientLookup key={workspace.studioId} studioId={workspace.studioId} ownOnly={ownOnly} />
      ) : (
        <StateMessage
          testID="clients-placeholder"
          title="Client lists are coming"
          body={
            studioWide
              ? "Searching the studio's clients will live here. Until then, use DanceFlow on the web."
              : "The dancers you teach will appear here. Until then, open a lesson from Today to see who it is with."
          }
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchField: { gap: space.xs },
  input: {
    ...type.body,
    minHeight: 48,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
    color: colors.text,
  },
  list: { gap: space.sm },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
    minHeight: 48,
    padding: space.lg,
    borderRadius: radius.row,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  rowPressed: { backgroundColor: colors.tint },
  rowName: { flexShrink: 1 },
});
