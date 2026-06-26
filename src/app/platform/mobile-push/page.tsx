import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendPlatformTestMobilePushAction } from "../actions";

type SearchParams = Promise<{
  status?: string;
  sent?: string;
  failed?: string;
  error?: string;
}>;

type PushTokenRow = {
  id: string;
  user_id: string;
  expo_push_token: string;
  platform: string;
  app_slug: string;
  device_name: string | null;
  enabled: boolean;
  last_registered_at: string;
  created_at: string;
};

type PushLogRow = {
  id: string;
  user_id: string;
  category: string;
  title: string;
  status: string;
  error_message: string | null;
  created_at: string;
};

function formatDateTime(value: string | null) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function maskToken(value: string) {
  if (value.length <= 24) return value;
  return `${value.slice(0, 18)}…${value.slice(-8)}`;
}

function statusMessage(searchParams: {
  status?: string;
  sent?: string;
  failed?: string;
  error?: string;
}) {
  if (searchParams.error === "missing_user") {
    return "Choose a dancer account before sending a test notification.";
  }

  if (!searchParams.status) return null;

  if (searchParams.status === "sent") {
    return `Test notification sent. Sent: ${searchParams.sent ?? "0"}. Failed: ${
      searchParams.failed ?? "0"
    }.`;
  }

  if (searchParams.status === "skipped") {
    return "Test notification skipped. The dancer may not have an active device or has turned off that notification type.";
  }

  return "Test notification failed. Check the recent log below for details.";
}

export default async function PlatformMobilePushPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePlatformAdmin();

  const resolvedSearchParams = await searchParams;
  const supabase = createAdminClient();

  const [{ data: tokens }, { data: logs }] = await Promise.all([
    supabase
      .from("mobile_push_tokens")
      .select(
        "id, user_id, expo_push_token, platform, app_slug, device_name, enabled, last_registered_at, created_at"
      )
      .order("last_registered_at", { ascending: false })
      .limit(50),
    supabase
      .from("mobile_notification_log")
      .select("id, user_id, category, title, status, error_message, created_at")
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  const tokenRows = (tokens ?? []) as PushTokenRow[];
  const logRows = (logs ?? []) as PushLogRow[];
  const message = statusMessage(resolvedSearchParams);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        <Link href="/platform" className="text-sm font-medium text-sky-700 hover:text-sky-900">
          ← Platform
        </Link>
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Mobile app
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-slate-950">
            Push notification test sender
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Send a controlled test notification to a registered DanceFlow mobile device.
            This checks the dancer's notification preferences, sends through Expo, and records
            the attempt in the mobile notification log.
          </p>
        </div>
      </div>

      {message ? (
        <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-medium text-sky-900">
          {message}
        </div>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-950">Send test notification</h2>
        <form action={sendPlatformTestMobilePushAction} className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Dancer account
            <select
              name="userId"
              required
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950"
            >
              <option value="">Choose a registered device</option>
              {tokenRows.map((token) => (
                <option key={token.id} value={token.user_id}>
                  {token.user_id} · {token.platform} · {token.enabled ? "active" : "inactive"}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Notification type
            <select
              name="category"
              defaultValue="account"
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950"
            >
              <option value="account">Account</option>
              <option value="schedule">Schedule</option>
              <option value="event">Event</option>
              <option value="favorites">Saved studios/events</option>
              <option value="learning">Learning</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Title
            <input
              name="title"
              defaultValue="DanceFlow test notification"
              className="rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-950"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Message
            <input
              name="body"
              defaultValue="Your DanceFlow mobile push setup is working."
              className="rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-950"
            />
          </label>

          <div className="md:col-span-2">
            <button
              type="submit"
              className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Send test notification
            </button>
          </div>
        </form>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-950">Registered devices</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Dancer account</th>
                <th className="px-3 py-2">Platform</th>
                <th className="px-3 py-2">Token</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Last registered</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tokenRows.length ? (
                tokenRows.map((token) => (
                  <tr key={token.id}>
                    <td className="px-3 py-3 font-mono text-xs text-slate-700">{token.user_id}</td>
                    <td className="px-3 py-3 text-slate-700">{token.platform}</td>
                    <td className="px-3 py-3 font-mono text-xs text-slate-500">
                      {maskToken(token.expo_push_token)}
                    </td>
                    <td className="px-3 py-3 text-slate-700">
                      {token.enabled ? "Active" : "Inactive"}
                    </td>
                    <td className="px-3 py-3 text-slate-700">
                      {formatDateTime(token.last_registered_at)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-3 py-4 text-slate-500" colSpan={5}>
                    No mobile devices have registered yet. Open the student app, sign in, and enable
                    notifications from Profile.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-950">Recent mobile notification log</h2>
        <div className="mt-4 divide-y divide-slate-100">
          {logRows.length ? (
            logRows.map((log) => (
              <div key={log.id} className="grid gap-1 py-3 text-sm md:grid-cols-[1fr_auto]">
                <div>
                  <p className="font-medium text-slate-950">{log.title}</p>
                  <p className="text-xs text-slate-500">
                    {log.category} · {log.status} · {log.user_id}
                  </p>
                  {log.error_message ? (
                    <p className="mt-1 text-xs text-rose-700">{log.error_message}</p>
                  ) : null}
                </div>
                <p className="text-xs text-slate-500">{formatDateTime(log.created_at)}</p>
              </div>
            ))
          ) : (
            <p className="text-sm text-slate-500">No mobile push notifications have been logged yet.</p>
          )}
        </div>
      </section>
    </main>
  );
}
