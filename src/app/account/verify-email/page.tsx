import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import PublicShell from "@/components/public/PublicShell";
import { getEmailBindingStatus, MIN_BINDING_PASSWORD_LENGTH } from "@/lib/auth/verifiedEmail";
import { normalizeLocalRedirectPath } from "@/lib/security/redirects";
import { createClient } from "@/lib/supabase/server";
import { bindPasswordAction, sendVerificationEmailAction } from "./actions";

export const metadata: Metadata = {
  title: "Secure your account",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

const ERROR_MESSAGES: Record<string, string> = {
  password_mismatch: "Those passwords do not match. Please try again.",
  weak_password: `Choose a password with at least ${MIN_BINDING_PASSWORD_LENGTH} characters.`,
  not_ready: "That verification link has expired. Send yourself a new one to continue.",
  bind_expired: "That verification link has expired. Send yourself a new one to continue.",
  not_authenticated: "Please sign in again to continue.",
  revoke_failed: "We could not finish securing your account. Please try again.",
  password_update_failed: "We could not save your password. Please try again.",
  send_failed: "We could not send the email right now. Please try again in a moment.",
  rate_limited: "Too many attempts. Please wait a few minutes and try again.",
  no_email: "Your account does not have an email address on file.",
};

const inputClass =
  "w-full rounded-xl border border-slate-300 px-3 py-3 text-slate-950 outline-none focus:border-slate-500";

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const params = (await searchParams) ?? {};
  const nextPath = normalizeLocalRedirectPath(single(params.next));
  const sent = single(params.sent) === "1";
  const errorCode = single(params.error) ?? "";
  const errorMessage = ERROR_MESSAGES[errorCode] ?? (errorCode ? "Something went wrong. Please try again." : "");
  const revokeFailed = single(params.revoke) === "failed";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/account/verify-email${nextPath ? `?next=${encodeURIComponent(nextPath)}` : ""}`)}`);
  }

  const status = await getEmailBindingStatus(supabase);
  const email = user.email ?? "";
  const continueHref = nextPath || "/account";

  return (
    <PublicShell>
      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_18%,#f8fafc_100%)]">
        <section className="mx-auto flex min-h-[70vh] max-w-2xl items-center px-6 py-12 lg:px-8">
          <div className="w-full rounded-[2rem] border border-slate-200 bg-white p-7 shadow-sm sm:p-9">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              Account security
            </p>

            {errorMessage ? (
              <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-800" role="alert">
                {errorMessage}
              </div>
            ) : null}

            {status === "binding_ready" ? (
              <>
                <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                  Create your password
                </h1>
                <p className="mt-4 text-base leading-7 text-slate-600">
                  Your email <span className="font-semibold text-slate-900">{email}</span> is
                  confirmed. Choose a password to finish securing your account. You will be
                  signed in again on this device.
                </p>
                {revokeFailed ? (
                  <p className="mt-3 text-sm leading-6 text-amber-700">
                    We could not sign out your other devices yet. Saving your password will
                    finish that step.
                  </p>
                ) : null}
                <form action={bindPasswordAction} className="mt-7 space-y-5">
                  <input type="hidden" name="next" value={nextPath} />
                  <div>
                    <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-slate-800">
                      New password
                    </label>
                    <input
                      id="password"
                      name="password"
                      type="password"
                      required
                      minLength={MIN_BINDING_PASSWORD_LENGTH}
                      autoComplete="new-password"
                      placeholder={`At least ${MIN_BINDING_PASSWORD_LENGTH} characters`}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="confirmPassword" className="mb-1.5 block text-sm font-medium text-slate-800">
                      Confirm password
                    </label>
                    <input
                      id="confirmPassword"
                      name="confirmPassword"
                      type="password"
                      required
                      minLength={MIN_BINDING_PASSWORD_LENGTH}
                      autoComplete="new-password"
                      className={inputClass}
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full rounded-xl bg-violet-600 px-4 py-3 text-sm font-medium text-white hover:bg-violet-700"
                  >
                    Save password and continue
                  </button>
                </form>
                {/*
                  Skipping only navigates away: it records no proof, never binds and
                  changes no credential state. It is acceptable only while 1C-B is
                  not live. 1C-B MUST NOT rely on UI routing; enforcement belongs at
                  the database/server claim boundaries (the verified-email helper).
                */}
                <Link
                  href={continueHref}
                  className="mt-3 inline-flex w-full items-center justify-center rounded-xl px-4 py-3 text-sm font-medium text-slate-600 hover:bg-slate-50"
                >
                  Skip for now
                </Link>
              </>
            ) : status === "bound" ? (
              <>
                <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                  Your email is verified
                </h1>
                <p className="mt-4 text-base leading-7 text-slate-600">
                  {email} is confirmed and your password is set.
                </p>
                <Link
                  href={continueHref}
                  className="mt-7 inline-flex w-full items-center justify-center rounded-xl bg-violet-600 px-4 py-3 text-sm font-medium text-white hover:bg-violet-700"
                >
                  Continue
                </Link>
              </>
            ) : (
              <>
                <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                  Verify your email
                </h1>
                <p className="mt-4 text-base leading-7 text-slate-600">
                  {sent
                    ? `We sent a secure link to ${email}. Open it on this device to continue.`
                    : `Confirm that ${email} belongs to you. We will email you a secure link, then you will create your password.`}
                </p>
                <form action={sendVerificationEmailAction} className="mt-7">
                  <input type="hidden" name="next" value={nextPath} />
                  <button
                    type="submit"
                    className="w-full rounded-xl bg-violet-600 px-4 py-3 text-sm font-medium text-white hover:bg-violet-700"
                  >
                    {sent ? "Send another link" : "Email me a verification link"}
                  </button>
                </form>
                <p className="mt-4 text-xs leading-6 text-slate-500">
                  Verification protects the studios and accounts connected to this email address.
                </p>
              </>
            )}
          </div>
        </section>
      </main>
    </PublicShell>
  );
}
