import { redirect } from "next/navigation";

/**
 * Public Event Registration E2E Harness -- Slice 3 bugfix.
 *
 * `/events` is a legacy path some server-side redirects (notably
 * `/api/events/cart/resume-after-signing`, which has no event slug in scope
 * at the point it needs to report a failure) still target with
 * `?error=...`/`?success=...` query parameters. This page's job is only to
 * send visitors on to the real listing at `/discover/events` -- but it used
 * to do that unconditionally, silently dropping every query parameter
 * (including the one carrying the error/success banner a caller was
 * counting on `/discover/events` to display). That silently destroyed the
 * user-visible context behind a resume-after-signing failure.
 *
 * Fix: forward every query parameter as-is onto the fixed, hardcoded
 * `/discover/events` destination. This is not an open redirect -- the
 * destination path is a compile-time constant, never derived from request
 * input, so no query value (however chosen) can redirect anywhere else.
 * `/discover/events` itself only acts on the specific parameter values it
 * already recognizes (see `resumeBanner.ts`) and otherwise ignores unknown
 * ones, so forwarding the full set is safe.
 */
export default async function EventsRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) params.append(key, entry);
    } else {
      params.append(key, value);
    }
  }

  const queryString = params.toString();
  redirect(queryString ? `/discover/events?${queryString}` : "/discover/events");
}
