import { buildSmsConsentDisclosureBody } from "@/lib/sms/compliance";

/**
 * A2P-1B: optional, unchecked-by-default SMS consent control for public studio forms.
 * The browser only contributes `smsConsent=yes` when checked; every other consent
 * value is derived on the server. Independent of any "preferred contact" field.
 */
export default function SmsConsentCheckbox({
  studioName,
  id = "smsConsent",
}: {
  studioName: string | null | undefined;
  id?: string;
}) {
  const linkClass = "font-medium underline underline-offset-2 hover:opacity-80";

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
      <label htmlFor={id} className="flex items-start gap-3 text-xs leading-5 text-slate-600">
        <input
          id={id}
          name="smsConsent"
          type="checkbox"
          value="yes"
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300"
        />
        <span>
          {buildSmsConsentDisclosureBody(studioName)} See our{" "}
          <a href="/terms" target="_blank" rel="noopener noreferrer" className={linkClass}>
            Terms
          </a>{" "}
          and{" "}
          <a href="/privacy" target="_blank" rel="noopener noreferrer" className={linkClass}>
            Privacy Policy
          </a>
          .
        </span>
      </label>
    </div>
  );
}
