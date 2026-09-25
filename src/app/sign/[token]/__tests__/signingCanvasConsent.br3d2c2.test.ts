import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SIGNING_CONSENT_ACKNOWLEDGEMENT,
  SIGNING_CONSENT_POLICY_LEAD_IN,
  SIGNING_CONSENT_POLICY_LINK_LABEL,
  SIGNING_CONSENT_TEXT,
} from "@/lib/documents/consent";

/**
 * BR-3D2c2: proves the public signing UI is the same source of truth as the
 * two completion paths, rather than an independently-typed literal that can
 * silently drift from what gets persisted (the exact defect this slice
 * fixes -- the UI previously said one sentence more than either completion
 * path ever recorded).
 *
 * The consent text is split into three fragments -- acknowledgement,
 * policy lead-in, policy link label -- specifically so the hyperlink can be
 * scoped to exactly "Electronic Records and Signature Consent", matching
 * the pre-BR-3D2c2 baseline markup byte-for-byte, while the full composed
 * plain text (and the persisted canonical value) remains unchanged.
 *
 * SigningCanvas.tsx has no existing test file and is a canvas-drawing,
 * multi-modal client component (real <canvas> refs/effects for a signature
 * pad) -- not a component this codebase's test setup (vitest,
 * environment: "node", no jsdom/testing-library) can safely fully render,
 * matching the same constraint already documented for other UI-only
 * conditionals in this codebase (see
 * PartialRefundReviewControlsStructure.test.ts). A structural check proves
 * the component imports and uses the shared fragments, with the lead-in
 * outside the link and the link label + trailing period matching baseline;
 * combined with a direct, real (unmocked) check that the three fragments'
 * composition equals SIGNING_CONSENT_TEXT exactly, this proves the actual
 * requirement -- the rendered plain text equals the canonical persisted
 * value, with the baseline hyperlink boundary preserved -- without needing
 * a full component render.
 */

const componentSource = readFileSync(
  fileURLToPath(new URL("../SigningCanvas.tsx", import.meta.url)),
  "utf8",
);

describe("SigningCanvas -- BR-3D2c2 shared consent source", () => {
  it("imports the shared consent fragments instead of an inline literal", () => {
    expect(componentSource).toMatch(
      /import\s*\{\s*SIGNING_CONSENT_ACKNOWLEDGEMENT,\s*SIGNING_CONSENT_POLICY_LEAD_IN,\s*SIGNING_CONSENT_POLICY_LINK_LABEL\s*\}\s*from\s*"@\/lib\/documents\/consent";/,
    );
  });

  it("no longer contains an independently-typed consent sentence", () => {
    // The historical bug: this exact English sentence was hand-typed here
    // AND separately (and shorter) in both completion paths. It must now
    // exist nowhere as a literal -- only as the imported constants.
    expect(componentSource).not.toMatch(
      /"I have reviewed this document, agree to use electronic records and signatures/,
    );
  });

  it("places the policy lead-in as plain text outside the link, the link label inside it, and the period outside", () => {
    const match = componentSource.match(
      /<span>\{SIGNING_CONSENT_ACKNOWLEDGEMENT\} \{SIGNING_CONSENT_POLICY_LEAD_IN\} <a[^>]*>\{SIGNING_CONSENT_POLICY_LINK_LABEL\}<\/a>\.<\/span>/,
    );
    expect(match).not.toBeNull();
  });

  it("preserves the existing link target and checkbox", () => {
    expect(componentSource).toMatch(/href="\/electronic-signature-consent"/);
    expect(componentSource).toMatch(/target="_blank"/);
    expect(componentSource).toMatch(/rel="noreferrer"/);
    expect(componentSource).toMatch(/<input type="checkbox" name="consent" required/);
  });

  it("the hyperlink scope matches the pre-BR-3D2c2 baseline exactly: only the link-label text is inside <a>", () => {
    // Baseline markup (confirmed by direct source read prior to this slice):
    // ...own. Review the <a ...>Electronic Records and Signature Consent</a>.
    // "Review the " is plain text before the link; "." is plain text after it.
    // Scoped specifically to the consent <span> (the component has other,
    // unrelated <a> tags elsewhere, e.g. "Open document").
    const spanMatch = componentSource.match(
      /<span>\{SIGNING_CONSENT_ACKNOWLEDGEMENT\}[\s\S]*?<a[^>]*>([^<]*)<\/a>\.<\/span>/,
    );
    // The anchor's source content is exactly the one expression -- no extra
    // literal text ("Review the " or the period) leaked inside the link.
    expect(spanMatch?.[1]).toBe("{SIGNING_CONSENT_POLICY_LINK_LABEL}");
    // And that expression resolves, at runtime, to exactly the baseline
    // link text.
    expect(SIGNING_CONSENT_POLICY_LINK_LABEL).toBe("Electronic Records and Signature Consent");
  });

  it("the three shared fragments compose to exactly the canonical consent text (real, unmocked values)", () => {
    expect(
      `${SIGNING_CONSENT_ACKNOWLEDGEMENT} ${SIGNING_CONSENT_POLICY_LEAD_IN} ${SIGNING_CONSENT_POLICY_LINK_LABEL}.`,
    ).toBe(SIGNING_CONSENT_TEXT);
    expect(SIGNING_CONSENT_TEXT).toBe(
      "I have reviewed this document, agree to use electronic records and signatures, and confirm that the signature I apply is my own. Review the Electronic Records and Signature Consent.",
    );
  });
});

/**
 * BR-3D2c2 lint-debt correction: SigningCanvas.tsx carried three pre-existing
 * lint findings (react-hooks/set-state-in-effect, react-hooks/exhaustive-deps,
 * @next/next/no-img-element) that this slice's diff never introduced, but
 * which the repo's whole-file "changed-file lint policy" still failed the PR
 * on, since this slice legitimately touches the file to consume the shared
 * consent fragments. This is structural, source-text protection only -- not
 * a runtime React render test -- for the same environment reason documented
 * above (vitest, environment: "node", no jsdom/testing-library). It proves
 * the three corrections preserve their documented behavioral contracts
 * (which trigger a reset, what goToPage depends on, what the signature
 * preview renders) without needing a full component render.
 */
describe("SigningCanvas -- BR-3D2c2 lint-debt correction (structural)", () => {
  it("Finding A: the modal reset is a render-time adjustment (not an effect) tracking kind, signerName, and open", () => {
    expect(componentSource).toMatch(
      /if \(\s*resetSnapshot\.kind !== kind \|\|\s*resetSnapshot\.signerName !== signerName \|\|\s*resetSnapshot\.open !== open\s*\) \{\s*setResetSnapshot\(\{ kind, signerName, open \}\);\s*setTypedValue\(kind === "initials" \? initials\(signerName\) : signerName\);\s*setMode\("typed"\);\s*\}/,
    );
    // The old reset effect must no longer exist: no useEffect body sets
    // typedValue/mode together over exactly this dependency array.
    expect(componentSource).not.toMatch(
      /useEffect\(\(\) => \{\s*setTypedValue\(kind === "initials" \? initials\(signerName\) : signerName\);\s*setMode\("typed"\);\s*\}, \[kind, signerName, open\]\);/,
    );
  });

  it("Finding B: goToPage is memoized with useCallback over pageCount, and the keydown effect depends on it", () => {
    expect(componentSource).toMatch(
      /const goToPage = useCallback\(\s*\(nextPage: number\) => \{\s*setPage\(Math\.min\(Math\.max\(nextPage, 1\), pageCount\)\);\s*\},\s*\[pageCount\],\s*\);/,
    );
    expect(componentSource).toMatch(
      /\}, \[canGoNext, canGoPrevious, page, pageCount, goToPage\]\);/,
    );
  });

  it("Finding C: the drawn-signature preview keeps the native <img>, narrowly suppressed, with its existing attributes", () => {
    const match = componentSource.match(
      /\/\/ eslint-disable-next-line @next\/next\/no-img-element\s*\n\s*(<img[^>]*\/>)/,
    );
    expect(match).not.toBeNull();
    const imgTag = match?.[1] ?? "";
    expect(imgTag).toContain('src={signature.value}');
    expect(imgTag).toContain('alt="Applied signature"');
    expect(imgTag).toContain('className="max-h-[70%] max-w-full object-contain"');
  });
});
