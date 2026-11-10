import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { ScheduleSkeleton } from "@/components/Skeleton";
import { StaffErrorState } from "@/components/StaffErrorState";
import { appointmentTypeLabel, clientStatusLabel, formatTime, personName } from "@/lib/format";
import { useStaffApi, useStaffSession } from "@/lib/staff";
import type { ClientDetail, ClientPackage, ClientPackageItem } from "@/lib/staffApi";
import { colors, radius, space, tabularNums } from "@/theme";

type LoadState = { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; client: ClientDetail };

/** In the studio's zone from the response; the device zone only if a server without slice 2 omits it. */
export function formatDateTime(iso: string, timeZone: string | null) {
  const zone = timeZone ?? undefined;
  let day: string;
  try {
    day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: zone }).format(new Date(iso));
  } catch {
    day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
  }
  return `${day}, ${formatTime(iso, zone)}`;
}

/** expiresOn is a calendar date in the studio's zone ("2027-01-31"): format it without shifting the day. */
export function formatExpiry(expiresOn: string | null) {
  if (!expiresOn) return "No expiry";
  const parsed = new Date(`${expiresOn}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return `Expires ${expiresOn}`;
  return `Expires ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(parsed)}`;
}

export function packageItemLabel(item: ClientPackageItem) {
  const what = appointmentTypeLabel(item.usageType);
  if (item.unlimited) return `${what}: unlimited`;
  if (item.remaining === null) return `${what}: not tracked`;
  return `${what}: ${item.remaining} remaining`;
}

function PackageRow({ pkg }: { pkg: ClientPackage }) {
  const lines = pkg.items.map(packageItemLabel);
  return (
    <View style={styles.pkg} accessible accessibilityLabel={[pkg.name, ...lines, formatExpiry(pkg.expiresOn)].join(". ")} testID={`package-${pkg.id}`}>
      <AppText variant="lead">{pkg.name}</AppText>
      {lines.map((line) => (
        <AppText key={line} style={tabularNums}>
          {line}
        </AppText>
      ))}
      <AppText variant="caption" tone="muted">
        {formatExpiry(pkg.expiresOn)}
      </AppText>
    </View>
  );
}

/**
 * A front-desk summary: name, status, active packages (remaining counts only) and what is next. For instructors the
 * server sends no status and no packages; those sections are hidden rather than shown empty.
 */
export function ClientDetailScreen({ clientId, studioId }: { clientId: string; studioId: string }) {
  const api = useStaffApi();
  const { reload: reloadWorkspaces, signOut } = useStaffSession();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", client: await api.client(studioId, clientId) });
    } catch (error) {
      setState({ status: "error", error });
    }
  }, [api, studioId, clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") {
    return (
      <Screen edges={[]}>
        <ScheduleSkeleton rows={2} label="Loading the client" />
      </Screen>
    );
  }

  if (state.status === "error") {
    return (
      <Screen edges={[]}>
        <StaffErrorState
          error={state.error}
          onRetry={() => void load()}
          onSignInAgain={() => void signOut()}
          onRefreshWorkspaces={() => void reloadWorkspaces()}
          copy={{ not_found: { title: "Client not found", body: "This client is gone, or isn't one of the clients you can see." } }}
        />
      </Screen>
    );
  }

  const { client } = state;
  const name = personName({ id: client.id, firstName: client.firstName, lastName: client.lastName }) ?? "Client";
  const status = clientStatusLabel(client.status);
  const next = client.nextAppointment;
  const nextTitle = next ? next.title || appointmentTypeLabel(next.appointmentType) : null;

  return (
    <Screen edges={[]}>
      <View style={styles.header}>
        <AppText variant="heading" accessibilityRole="header">
          {name}
        </AppText>
        {status ? <AppText tone="muted">{status}</AppText> : null}
      </View>

      <View style={styles.section} testID="next-booking">
        <AppText variant="label" tone="muted" accessibilityRole="header">
          Next booking
        </AppText>
        {next ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${nextTitle}, ${formatDateTime(next.startsAt, client.timeZone)}`}
            accessibilityHint="Opens the appointment"
            onPress={() =>
              router.push({
                pathname: "/appointments/[id]",
                params: { id: next.id, studioId, ...(client.timeZone ? { tz: client.timeZone } : {}) },
              })
            }
            style={({ pressed }) => [styles.next, pressed && styles.pressed]}
          >
            <AppText variant="lead">{nextTitle}</AppText>
            <AppText tone="muted" style={tabularNums}>
              {formatDateTime(next.startsAt, client.timeZone)}
            </AppText>
          </Pressable>
        ) : (
          <AppText tone="muted">Nothing booked.</AppText>
        )}
      </View>

      {client.activePackages ? (
        <View style={styles.section} testID="client-packages">
          <AppText variant="label" tone="muted" accessibilityRole="header">
            Active packages
          </AppText>
          {client.activePackages.length === 0 ? <AppText tone="muted">No active packages.</AppText> : null}
          {client.activePackages.map((pkg) => (
            <PackageRow key={pkg.id} pkg={pkg} />
          ))}
        </View>
      ) : null}

      <AppText variant="caption" tone="muted">
        {client.activePackages ? "Contact details, prices and payments stay on DanceFlow for the web." : "Contact details and client records stay on DanceFlow for the web."}
      </AppText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xs },
  section: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
  },
  next: { gap: 2, minHeight: 44, justifyContent: "center", paddingVertical: space.xs, borderRadius: radius.control },
  pressed: { backgroundColor: colors.tint },
  pkg: { gap: 2, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: colors.border },
});
