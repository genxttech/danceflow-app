import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import PublicShell from "@/components/public/PublicShell";
import { createClient } from "@/lib/supabase/server";
import { buildEmailVerificationPath, getEmailBindingStatus } from "@/lib/auth/verifiedEmail";
import { getMyVerifiedEmail } from "@/lib/auth/verifiedIdentity";
import { portalClientPath } from "@/lib/student-identity/portal-context";
import {
  fetchPublicGroupClass,
  formatClassDay,
  formatClassTimeRange,
  publicClassesPath,
  publicClassPath,
  sameStudioSlug,
  type PublicGroupClass,
} from "@/lib/public/groupClasses";
import {
  canProceedToRegister,
  classRegisterPath,
  fundingChoiceValue,
  fundingSummary,
  registerUnavailableMessage,
  resolveRegistrationDancer,
  toRegistrationFundingCandidates,
  type ManageableDancer,
  type RegistrationFundingCandidate,
} from "@/lib/public/classRegistration";
import {
  getStudioIdForPublicSlug,
  hasActiveClassEnrollment,
  listManageableDancers,
} from "@/lib/public/classRegistrationData";
import { isSelfEnrollmentErrorKind, selfEnrollmentErrorMessage } from "@/lib/schedule/selfEnrollmentErrors";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  hasLinkedStudioRelationship,
  loadLatestOwnPurchase,
  loadPublicClassPaymentOffer,
  loadPurchaserPrefill,
  loadPurchaseSettlementState,
  type PublicClassPaymentOffer,
} from "@/lib/payments/groupClassPurchase";
import {
  FINALIZING_POLL,
  classPurchaseErrorMessage,
  formatUsdCents,
  isClassPurchaseErrorKind,
  parsePurchaseReturnFlag,
  resolvePurchaseView,
  type PurchaseView,
} from "@/lib/public/classPurchase";
import PurchaseFinalizingPoller from "./PurchaseFinalizingPoller";
import {
  checkClassRegistrationLinkAction,
  enrollInClassAction,
  releaseClassPurchaseAction,
  signInAgainForClassAction,
  startClassPurchaseAction,
} from "./actions";

type PageProps = {
  params: Promise<{ studioSlug: string; appointmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = { title: "Class registration" };

// Always per-request: identity and relationships are re-resolved every time.
export const dynamic = "force-dynamic";

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

const primaryButton =
  "inline-flex justify-center rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800";
const secondaryButton =
  "inline-flex justify-center rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-50";

function RegisterShell({ item, children }: { item: PublicGroupClass; children: ReactNode }) {
  return (
    <PublicShell currentPath="discover">
      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#f8fafc_34%,#ffffff_100%)] text-slate-900">
        <section className="mx-auto max-w-xl px-4 py-10 sm:px-6 lg:py-14">
          <Link
            href={publicClassPath(item.studioSlug, item.appointmentId)}
            className="text-sm font-semibold text-[var(--brand-primary)] underline"
          >
            Back to class
          </Link>
          <div className="mt-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <p className="text-sm font-medium text-slate-600">
              {item.title} · {formatClassDay(item.startsAt, item.timeZone)},{" "}
              {formatClassTimeRange(item.startsAt, item.endsAt, item.timeZone)} · {item.studioName}
            </p>
            {children}
          </div>
        </section>
      </main>
    </PublicShell>
  );
}

function StepTitle({ children }: { children: ReactNode }) {
  return <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">{children}</h1>;
}

function StepText({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-base leading-7 text-slate-700">{children}</p>;
}

const inputClass =
  "mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-base text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900";

/**
 * GC-3.5-3: the minimal identity form for a public paid registration (self only). The browser posts only the class id and
 * the dancer's names/phone; the price shown here is a display preview -- the charge is the hold's server-snapshotted amount.
 */
function PurchaseForm({
  item,
  amountCents,
  email,
  prefill,
  submitLabel,
}: {
  item: PublicGroupClass;
  amountCents: number;
  email: string;
  prefill: { firstName: string; lastName: string; phone: string };
  submitLabel?: string;
}) {
  if (submitLabel) {
    // Resume: the existing hold keeps its own snapshot (start_public_class_purchase reuses it unchanged).
    return (
      <form action={startClassPurchaseAction} className="mt-6">
        <input type="hidden" name="appointmentId" value={item.appointmentId} />
        <input type="hidden" name="firstName" value={prefill.firstName} />
        <input type="hidden" name="lastName" value={prefill.lastName} />
        <button type="submit" className={`${primaryButton} w-full sm:w-auto`}>
          {submitLabel}
        </button>
      </form>
    );
  }
  return (
    <form action={startClassPurchaseAction} className="mt-6 space-y-4">
      <input type="hidden" name="appointmentId" value={item.appointmentId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium text-slate-800">
          First name
          <input name="firstName" defaultValue={prefill.firstName} required maxLength={100} autoComplete="given-name" className={inputClass} />
        </label>
        <label className="block text-sm font-medium text-slate-800">
          Last name
          <input name="lastName" defaultValue={prefill.lastName} required maxLength={100} autoComplete="family-name" className={inputClass} />
        </label>
      </div>
      <label className="block text-sm font-medium text-slate-800">
        Phone <span className="font-normal text-slate-500">(optional)</span>
        <input name="phone" type="tel" defaultValue={prefill.phone} maxLength={32} autoComplete="tel" className={inputClass} />
      </label>
      <p className="text-sm text-slate-600">Your receipt and confirmation will go to {email}.</p>
      <button type="submit" className={`${primaryButton} w-full sm:w-auto`}>
        {`Pay ${formatUsdCents(amountCents)}`}
      </button>
      <p className="text-xs text-slate-500">
        You&apos;ll pay securely with Stripe. You&apos;re registered once your payment is confirmed.
      </p>
    </form>
  );
}

function ReleaseForm({ item, holdId }: { item: PublicGroupClass; holdId: string }) {
  return (
    <form action={releaseClassPurchaseAction}>
      <input type="hidden" name="appointmentId" value={item.appointmentId} />
      <input type="hidden" name="holdId" value={holdId} />
      <button type="submit" className={`${secondaryButton} w-full`}>
        Cancel registration
      </button>
    </form>
  );
}

/** The authoritative purchase state (database only; the return flag only picks wording). */
function PurchaseStatusView({
  item,
  view,
  email,
}: {
  item: PublicGroupClass;
  view: Exclude<PurchaseView, { kind: "none" }>;
  email: string | null;
}) {
  const { purchase } = view;
  const dancerName = [purchase.dancerFirstName, purchase.dancerLastName].filter(Boolean).join(" ");
  const amount = formatUsdCents(purchase.amountCents);
  const classWhen = `${formatClassDay(item.startsAt, item.timeZone)}, ${formatClassTimeRange(item.startsAt, item.endsAt, item.timeZone)}`;
  const contact = (
    <Link href={`/studios/${encodeURIComponent(item.studioSlug)}`} className={secondaryButton}>
      Contact {item.studioName}
    </Link>
  );
  const resumeForm = (label: string) => (
    <PurchaseForm
      item={item}
      amountCents={purchase.amountCents}
      email={email ?? "your account email"}
      prefill={{ firstName: purchase.dancerFirstName, lastName: purchase.dancerLastName, phone: "" }}
      submitLabel={label}
    />
  );

  switch (view.kind) {
    case "registered":
      return (
        <RegisterShell item={item}>
          <StepTitle>You&apos;re registered</StepTitle>
          <StepText>
            {dancerName || "You"} {dancerName ? "is" : "are"} registered for {item.title} on {classWhen} at {item.studioName}.
          </StepText>
          <p className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">Paid online — {amount}</p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link href={portalClientPath(item.studioSlug, purchase.clientId ?? "")} className={primaryButton}>
              Open Student Portal
            </Link>
          </div>
        </RegisterShell>
      );
    case "finalizing":
      return (
        <RegisterShell item={item}>
          <StepTitle>Payment received — finalizing…</StepTitle>
          <StepText>We&apos;re confirming your registration with {item.studioName}. This usually takes a few seconds.</StepText>
          <PurchaseFinalizingPoller attempts={FINALIZING_POLL.attempts} intervalMs={FINALIZING_POLL.intervalMs} />
        </RegisterShell>
      );
    case "checkout_open":
      return (
        <RegisterShell item={item}>
          <StepTitle>Finish your payment</StepTitle>
          <StepText>Your spot in {item.title} is being held while you pay ({amount}).</StepText>
          {resumeForm("Continue to payment")}
          <div className="mt-4">
            <ReleaseForm item={item} holdId={purchase.holdId} />
          </div>
        </RegisterShell>
      );
    case "not_completed":
      return (
        <RegisterShell item={item}>
          <StepTitle>Payment not completed — try again</StepTitle>
          <StepText>You haven&apos;t been charged. Your spot is held for a short time if you&apos;d like to try again.</StepText>
          {resumeForm("Try again")}
          <div className="mt-4">
            <ReleaseForm item={item} holdId={purchase.holdId} />
          </div>
        </RegisterShell>
      );
    case "refunded":
      return (
        <RegisterShell item={item}>
          <StepTitle>Your payment was refunded</StepTitle>
          <StepText>
            Your payment was refunded because registration could not be completed. Refunds usually appear on your statement
            within 5–10 business days.
          </StepText>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link href={publicClassPath(item.studioSlug, item.appointmentId)} className={primaryButton}>
              Back to class
            </Link>
            {contact}
          </div>
        </RegisterShell>
      );
    case "needs_studio":
    default:
      return (
        <RegisterShell item={item}>
          <StepTitle>We couldn&apos;t finish registration</StepTitle>
          <StepText>
            We couldn&apos;t complete your registration for this class. Please contact {item.studioName} about your payment.
          </StepText>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">{contact}</div>
        </RegisterShell>
      );
  }
}

/**
 * GC-3.4B-1 identity step. The public class page stays auth-free; this route is
 * the registration intent. Order: public class truth -> sign-in -> verified
 * email -> the account's own manageable relationships at this studio ->
 * dancer -> "Open Student Portal". Nothing here enrolls, charges or links.
 */
export default async function ClassRegisterPage({ params, searchParams }: PageProps) {
  const { studioSlug, appointmentId } = await params;
  const search = await searchParams;
  const supabase = await createClient();

  // 1. Public class truth (same narrow read model as the class page).
  const item = await fetchPublicGroupClass(supabase, appointmentId);
  if (!item) notFound();

  const registerPath = classRegisterPath(item.studioSlug, item.appointmentId);
  if (!sameStudioSlug(studioSlug, item.studioSlug)) redirect(registerPath);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // GC-3.5-3: the purchaser's own public paid registration, if any, comes first (it may hold or have taken the last seat).
  // Database state only; the ?purchase flag picks wording and never changes anything.
  if (user) {
    let view: PurchaseView = { kind: "none" };
    try {
      const purchase = await loadLatestOwnPurchase(supabase, { appointmentId: item.appointmentId, userId: user.id });
      if (purchase) {
        const purchaseStudioId = await getStudioIdForPublicSlug(item.studioSlug);
        const settlement = purchaseStudioId
          ? await loadPurchaseSettlementState(createAdminClient(), { studioId: purchaseStudioId, purchase })
          : { attendeeActive: false, refunded: false };
        view = resolvePurchaseView({ purchase, returnFlag: parsePurchaseReturnFlag(single(search.purchase)), ...settlement });
      }
    } catch {
      view = { kind: "none" };
    }
    if (view.kind !== "none") {
      const email =
        view.kind === "checkout_open" || view.kind === "not_completed" ? await getMyVerifiedEmail(supabase) : null;
      return <PurchaseStatusView item={item} view={view} email={email} />;
    }
  }

  if (!canProceedToRegister(item)) {
    return (
      <RegisterShell item={item}>
        <StepTitle>Registration isn&apos;t available</StepTitle>
        <StepText>{registerUnavailableMessage(item)}</StepText>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Link href={publicClassPath(item.studioSlug, item.appointmentId)} className={primaryButton}>
            Back to class
          </Link>
          <Link href={publicClassesPath()} className={secondaryButton}>
            Browse classes
          </Link>
        </div>
      </RegisterShell>
    );
  }

  // 2. Signed in? The route itself is the intent, so sign-in returns here.
  if (!user) {
    redirect(`/login?intent=public&next=${encodeURIComponent(registerPath)}`);
  }

  // 3. Canonical verified identity only (never user.email or the JWT claim).
  const verifiedEmail = await getMyVerifiedEmail(supabase);
  if (!verifiedEmail && (await getEmailBindingStatus(supabase)) === "bound") {
    // The email is already confirmed, but this session started before that;
    // a fresh sign-in creates a session the verified-email check accepts.
    return (
      <RegisterShell item={item}>
        <StepTitle>Sign in again to continue</StepTitle>
        <StepText>
          Your email is confirmed. For your security, please sign in again and we&apos;ll bring you right back
          to this class.
        </StepText>
        <form action={signInAgainForClassAction} className="mt-6">
          <input type="hidden" name="appointmentId" value={item.appointmentId} />
          <button type="submit" className={primaryButton}>
            Sign in again
          </button>
        </form>
      </RegisterShell>
    );
  }

  if (!verifiedEmail) {
    return (
      <RegisterShell item={item}>
        <StepTitle>Confirm your email to continue</StepTitle>
        <StepText>
          Before we can connect you with {item.studioName}, confirm the email address on your DanceFlow
          account. We&apos;ll bring you right back to this class.
        </StepText>
        <div className="mt-6">
          <Link href={buildEmailVerificationPath(registerPath)} className={primaryButton}>
            Confirm my email
          </Link>
        </div>
      </RegisterShell>
    );
  }

  // 4. The account's own manageable relationships at this class's studio.
  let dancers: ManageableDancer[];
  let studioId: string | null;
  try {
    studioId = await getStudioIdForPublicSlug(item.studioSlug);
    dancers = studioId ? await listManageableDancers({ userId: user.id, studioId }) : [];
  } catch {
    return (
      <RegisterShell item={item}>
        <StepTitle>Something went wrong</StepTitle>
        <StepText>We couldn&apos;t load your account details right now. Please try again in a moment.</StepText>
        <div className="mt-6">
          <Link href={registerPath} className={primaryButton}>
            Try again
          </Link>
        </div>
      </RegisterShell>
    );
  }

  const resolution = resolveRegistrationDancer(dancers, single(search.dancer));

  // A dancer id that is not one of this account's own manageable dancers here
  // selects nothing: start again from the clean intent.
  if (resolution.kind === "invalid_selection") redirect(registerPath);

  if (resolution.kind === "unlinked") {
    // GC-3.5-3: a verified account with NO linked relationship at this studio may register and pay online when the
    // class offers direct payment (self-registration only). Anyone linked here (even view-only) keeps the existing state.
    let offer: PublicClassPaymentOffer = { available: false, reason: "not_offered" };
    try {
      const admin = createAdminClient();
      if (studioId && !(await hasLinkedStudioRelationship(admin, { userId: user.id, studioId }))) {
        offer = await loadPublicClassPaymentOffer(admin, { studioId, appointmentId: item.appointmentId });
      }
    } catch {
      offer = { available: false, reason: "not_offered" };
    }

    const purchaseErrorKind = single(search.purchase_error);
    const purchaseError = isClassPurchaseErrorKind(purchaseErrorKind)
      ? classPurchaseErrorMessage(purchaseErrorKind, item.studioName)
      : null;
    const purchaseErrorBanner = purchaseError ? (
      <p role="alert" className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800">
        {purchaseError}
      </p>
    ) : null;

    if (offer.available) {
      const prefill = await loadPurchaserPrefill(createAdminClient(), user);
      return (
        <RegisterShell item={item}>
          <StepTitle>Register for {item.title}</StepTitle>
          <StepText>
            Price: <span className="font-semibold text-slate-950">{formatUsdCents(offer.amountCents)}</span>
          </StepText>
          {purchaseErrorBanner}
          <PurchaseForm item={item} amountCents={offer.amountCents} email={verifiedEmail} prefill={prefill} />
        </RegisterShell>
      );
    }

    if (offer.reason === "payment_not_ready") {
      return (
        <RegisterShell item={item}>
          <StepTitle>Online payment isn&apos;t available</StepTitle>
          <StepText>Online payment is not available for this class right now. Please contact {item.studioName}.</StepText>
          <div className="mt-6">
            <Link href={`/studios/${encodeURIComponent(item.studioSlug)}`} className={primaryButton}>
              Contact {item.studioName}
            </Link>
          </div>
        </RegisterShell>
      );
    }

    // One generic state for every "no safe link" case: no invitation, expired
    // or ambiguous invitations, a failed claim, or no record at all.
    const check = single(search.check);
    return (
      <RegisterShell item={item}>
        <StepTitle>You&apos;re not set up with {item.studioName} yet</StepTitle>
        <StepText>
          Your DanceFlow account isn&apos;t connected to a student you can book for at this studio yet. Ask{" "}
          {item.studioName} to send you a student portal invitation, accept it, then come back to this class.
        </StepText>
        {check === "done" ? (
          <p role="status" className="mt-4 rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-700">
            We checked again. Nothing has changed yet.
          </p>
        ) : check === "wait" ? (
          <p role="status" className="mt-4 rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-700">
            Please wait a few minutes before checking again.
          </p>
        ) : null}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Link href={`/studios/${encodeURIComponent(item.studioSlug)}`} className={primaryButton}>
            Contact {item.studioName}
          </Link>
          <form action={checkClassRegistrationLinkAction}>
            <input type="hidden" name="appointmentId" value={item.appointmentId} />
            <button type="submit" className={`${secondaryButton} w-full`}>
              Check again
            </button>
          </form>
        </div>
      </RegisterShell>
    );
  }

  if (resolution.kind === "choose") {
    return (
      <RegisterShell item={item}>
        <StepTitle>Who is this class for?</StepTitle>
        <ul className="mt-5 space-y-3">
          {resolution.dancers.map((dancer) => (
            <li key={dancer.clientId}>
              <Link
                href={classRegisterPath(item.studioSlug, item.appointmentId, dancer.clientId)}
                className="flex items-center justify-between rounded-2xl border border-slate-200 px-4 py-3 text-base font-semibold text-slate-900 hover:border-slate-400"
              >
                <span>
                  {dancer.displayName}
                  {dancer.isSelf ? <span className="ml-2 text-sm font-normal text-slate-500">(you)</span> : null}
                </span>
                <span aria-hidden="true" className="text-slate-400">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </RegisterShell>
    );
  }

  const { dancer } = resolution;
  const portalHref = portalClientPath(item.studioSlug, dancer.clientId);
  const otherDancerLink =
    resolution.dancers.length > 1 ? (
      <Link href={registerPath} className={secondaryButton}>
        Choose a different dancer
      </Link>
    ) : null;

  // GC-3.4C: enrollment state for the resolved dancer. "Registered" comes from
  // the database (an active enrollment), never from a URL flag; funding comes
  // from the canonical preview RPC on the user session (advisory only -- the
  // enrollment RPC re-validates everything).
  let alreadyRegistered: boolean;
  let candidates: RegistrationFundingCandidate[];
  try {
    alreadyRegistered = studioId
      ? await hasActiveClassEnrollment({ studioId, appointmentId: item.appointmentId, clientId: dancer.clientId })
      : false;
    candidates = [];
    if (!alreadyRegistered) {
      const { data, error } = await supabase.rpc("preview_self_enrollment_funding_candidates", {
        p_appointment_id: item.appointmentId,
        p_client_id: dancer.clientId,
      });
      if (error) throw new Error("preview failed");
      candidates = toRegistrationFundingCandidates(data as Array<{ funding_type: string; source_id: string; label: string | null }>);
    }
  } catch {
    return (
      <RegisterShell item={item}>
        <StepTitle>Something went wrong</StepTitle>
        <StepText>We couldn&apos;t load this registration right now. Please try again in a moment.</StepText>
        <div className="mt-6">
          <Link href={classRegisterPath(item.studioSlug, item.appointmentId, dancer.clientId)} className={primaryButton}>
            Try again
          </Link>
        </div>
      </RegisterShell>
    );
  }

  const classWhen = `${formatClassDay(item.startsAt, item.timeZone)}, ${formatClassTimeRange(item.startsAt, item.endsAt, item.timeZone)}`;

  if (alreadyRegistered) {
    return (
      <RegisterShell item={item}>
        <StepTitle>You&apos;re registered</StepTitle>
        <StepText>
          {dancer.isSelf ? "You're" : `${dancer.displayName} is`} registered for {item.title} on {classWhen} at{" "}
          {item.studioName}.
        </StepText>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Link href={portalHref} className={primaryButton}>
            Open Student Portal
          </Link>
          {otherDancerLink}
        </div>
      </RegisterShell>
    );
  }

  const errorKind = single(search.error);
  const errorText = isSelfEnrollmentErrorKind(errorKind) ? selfEnrollmentErrorMessage(errorKind) : null;
  const errorBanner = errorText ? (
    <p role="alert" className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800">
      {errorText}
    </p>
  ) : null;

  if (candidates.length === 0) {
    // Non-payment boundary (direct payment is GC-3.5): nothing to enroll with.
    return (
      <RegisterShell item={item}>
        <StepTitle>No class credit available</StepTitle>
        <StepText>
          No eligible class credit is available for online registration
          {dancer.isSelf ? "" : ` for ${dancer.displayName}`}. Contact {item.studioName} to get set up for this class.
        </StepText>
        {errorBanner}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Link href={`/studios/${encodeURIComponent(item.studioSlug)}`} className={primaryButton}>
            Contact {item.studioName}
          </Link>
          <Link href={portalHref} className={secondaryButton}>
            Open Student Portal
          </Link>
        </div>
      </RegisterShell>
    );
  }

  return (
    <RegisterShell item={item}>
      <StepTitle>Join {item.title}</StepTitle>
      <StepText>
        {dancer.isSelf ? "For you" : `For ${dancer.displayName}`} · {classWhen} · {item.studioName}
      </StepText>
      {errorBanner}
      <form action={enrollInClassAction} className="mt-6">
        <input type="hidden" name="appointmentId" value={item.appointmentId} />
        <input type="hidden" name="dancer" value={dancer.clientId} />
        {candidates.length === 1 ? (
          <p className="text-sm text-slate-700">{fundingSummary(candidates[0])}</p>
        ) : (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">How should this class be covered?</legend>
            {candidates.map((candidate) => (
              <label key={fundingChoiceValue(candidate)} className="flex items-center gap-2 text-sm text-slate-700">
                {/* Nothing pre-checked: with several eligible sources the dancer must choose. */}
                <input type="radio" name="fundingChoice" value={fundingChoiceValue(candidate)} required className="h-4 w-4" />
                {fundingSummary(candidate)}
              </label>
            ))}
          </fieldset>
        )}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button type="submit" className={primaryButton}>
            Join this class
          </button>
          {otherDancerLink}
        </div>
      </form>
    </RegisterShell>
  );
}
