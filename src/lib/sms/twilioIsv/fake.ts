import { IsvApiError, type BrandStatus, type BundleStatus, type EndUserType, type EvaluationResult, type IsvAdapter } from "./types";

/**
 * TW-4 R1: an in-memory Twilio stand-in. It is the ONLY implementation used by tests and by non-production environments.
 * It behaves like Twilio where the runner depends on it: deterministic SIDs, FriendlyName lookups for profiles and trust
 * products, brand lookup by bundle linkage, evaluations, and, importantly, injectable failures including the dangerous one:
 * the request SUCCEEDS inside "Twilio" but the caller sees a transient error (`lostResponse`), which is exactly the
 * "unknown outcome" case the runner must reconcile instead of repeating.
 */

type Method = keyof IsvAdapter;
type Failure = { kind: "validation" | "transient" | "account" | "unexpected"; lostResponse?: boolean; code?: string };

export class FakeIsvAdapter implements IsvAdapter {
  /** Every call in order: `method` and a sanitized view of its inputs (attribute values are recorded for assertions). */
  readonly calls: { method: Method; input: unknown }[] = [];
  readonly profiles = new Map<string, { friendlyName: string; status: BundleStatus; assigned: string[]; submitted: boolean; email: string; policySid: string | null }>();
  readonly trustProducts = new Map<string, { friendlyName: string; status: BundleStatus; assigned: string[]; submitted: boolean; email: string }>();
  readonly endUsers = new Map<string, { type: EndUserType; attributes: Record<string, string> }>();
  readonly brands = new Map<string, { customerProfileSid: string; trustProductSid: string; status: BrandStatus; mock: boolean }>();
  primaryStatus: BundleStatus = "twilio-approved";
  /** Failed fields per evaluation target (`profile` | `trustProduct`); empty = compliant. */
  evaluationFailures: Record<"profile" | "trustProduct", string[]> = { profile: [], trustProduct: [] };
  private counter = 0;
  private failures: { method: Method; failure: Failure }[] = [];

  /**
   * @param options.captureSensitive keep the EIN in the recorded calls and end users. OFF by default so a demo/local fake never holds a
   *   plaintext EIN in process memory; the runner's EIN-handling tests turn it on deliberately.
   */
  constructor(public readonly primaryProfileSid: string, private readonly options: { captureSensitive?: boolean; primaryPolicySid?: string } = {}) {
    this.profiles.set(primaryProfileSid, {
      friendlyName: "primary", status: "twilio-approved", assigned: [], submitted: true, email: "isv@example.test",
      policySid: options.primaryPolicySid ?? `RN${"a".repeat(32)}`,
    });
  }

  private scrub(attributes: Record<string, string>): Record<string, string> {
    if (this.options.captureSensitive || attributes.business_registration_number === undefined) return attributes;
    return { ...attributes, business_registration_number: "[redacted]" };
  }

  /** The next call of `method` fails once. */
  failNext(method: Method, failure: Failure) {
    this.failures.push({ method, failure });
  }

  count(method: Method) {
    return this.calls.filter((call) => call.method === method).length;
  }

  private sid(prefix: string) {
    this.counter += 1;
    return `${prefix}${this.counter.toString(16).padStart(32, "0")}`;
  }

  private enter(method: Method, input: unknown): Failure | null {
    this.calls.push({ method, input });
    const index = this.failures.findIndex((entry) => entry.method === method);
    if (index < 0) return null;
    const [entry] = this.failures.splice(index, 1);
    return entry.failure;
  }

  private throwFor(failure: Failure): never {
    if (failure.kind === "unexpected") throw new Error("fake unexpected failure");
    const status = failure.kind === "validation" ? 400 : failure.kind === "account" ? 401 : 503;
    throw new IsvApiError(failure.kind, status, failure.code ?? null, `fake ${failure.kind} failure`);
  }

  /** Run `effect` (which creates the resource) and then raise the injected failure, honoring `lostResponse`. */
  private guarded<T>(method: Method, input: unknown, effect: () => T): T {
    const failure = this.enter(method, input);
    if (failure && !failure.lostResponse) this.throwFor(failure);
    const result = effect();
    if (failure && failure.lostResponse) this.throwFor(failure);
    return result;
  }

  async getCustomerProfile(profileSid: string) {
    return this.guarded("getCustomerProfile", { profileSid }, () => {
      const profile = this.profiles.get(profileSid);
      return { status: profile?.status ?? "unknown", policySid: profile?.policySid ?? null };
    });
  }

  async findCustomerProfile(friendlyName: string) {
    return this.guarded("findCustomerProfile", { friendlyName }, () => [...this.profiles.entries()].filter(([, p]) => p.friendlyName === friendlyName).map(([sid]) => sid));
  }

  async createCustomerProfile(input: { friendlyName: string; email: string }) {
    return this.guarded("createCustomerProfile", input, () => {
      const sid = this.sid("BU");
      this.profiles.set(sid, { friendlyName: input.friendlyName, status: "draft", assigned: [], submitted: false, email: input.email, policySid: null });
      return sid;
    });
  }

  async createEndUser(input: { friendlyName: string; type: EndUserType; attributes: Record<string, string> }) {
    const recorded = { ...input, attributes: this.scrub(input.attributes) };
    return this.guarded("createEndUser", recorded, () => {
      const sid = this.sid("IT");
      this.endUsers.set(sid, { type: input.type, attributes: recorded.attributes });
      return sid;
    });
  }

  async createAddress(input: Parameters<IsvAdapter["createAddress"]>[0]) {
    return this.guarded("createAddress", input, () => this.sid("AD"));
  }

  async createSupportingDocument(input: { friendlyName: string; addressSid: string }) {
    return this.guarded("createSupportingDocument", input, () => this.sid("RD"));
  }

  async assignToCustomerProfile(profileSid: string, objectSid: string) {
    return this.guarded("assignToCustomerProfile", { profileSid, objectSid }, () => {
      const profile = this.profiles.get(profileSid);
      if (!profile) throw new IsvApiError("validation", 404, "20404", "fake: profile not found");
      profile.assigned.push(objectSid);
      return this.sid("BV");
    });
  }

  async evaluateCustomerProfile(profileSid: string) {
    return this.guarded("evaluateCustomerProfile", { profileSid }, () => {
      const result = this.evaluation(this.evaluationFailures.profile);
      return { evaluationSid: this.sid("EL"), result };
    });
  }

  async submitCustomerProfile(profileSid: string) {
    return this.guarded("submitCustomerProfile", { profileSid }, () => {
      const profile = this.profiles.get(profileSid);
      if (!profile) throw new IsvApiError("validation", 404, "20404", "fake: profile not found");
      profile.submitted = true;
      profile.status = "pending-review";
      return profileSid;
    });
  }

  async findTrustProduct(friendlyName: string) {
    return this.guarded("findTrustProduct", { friendlyName }, () => [...this.trustProducts.entries()].filter(([, p]) => p.friendlyName === friendlyName).map(([sid]) => sid));
  }

  async createTrustProduct(input: { friendlyName: string; email: string }) {
    return this.guarded("createTrustProduct", input, () => {
      const sid = this.sid("BU");
      this.trustProducts.set(sid, { friendlyName: input.friendlyName, status: "draft", assigned: [], submitted: false, email: input.email });
      return sid;
    });
  }

  async assignToTrustProduct(trustProductSid: string, objectSid: string) {
    return this.guarded("assignToTrustProduct", { trustProductSid, objectSid }, () => {
      const product = this.trustProducts.get(trustProductSid);
      if (!product) throw new IsvApiError("validation", 404, "20404", "fake: trust product not found");
      product.assigned.push(objectSid);
      return this.sid("BV");
    });
  }

  async evaluateTrustProduct(trustProductSid: string) {
    return this.guarded("evaluateTrustProduct", { trustProductSid }, () => ({ evaluationSid: this.sid("EL"), result: this.evaluation(this.evaluationFailures.trustProduct) }));
  }

  async submitTrustProduct(trustProductSid: string) {
    return this.guarded("submitTrustProduct", { trustProductSid }, () => {
      const product = this.trustProducts.get(trustProductSid);
      if (!product) throw new IsvApiError("validation", 404, "20404", "fake: trust product not found");
      product.submitted = true;
      product.status = "pending-review";
      return trustProductSid;
    });
  }

  async findBrand(input: { customerProfileSid: string; trustProductSid: string }) {
    return this.guarded("findBrand", input, () =>
      [...this.brands.entries()].filter(([, b]) => b.customerProfileSid === input.customerProfileSid && b.trustProductSid === input.trustProductSid).map(([sid]) => sid),
    );
  }

  async createBrand(input: Parameters<IsvAdapter["createBrand"]>[0]) {
    return this.guarded("createBrand", input, () => {
      const profile = this.profiles.get(input.customerProfileSid);
      const product = this.trustProducts.get(input.trustProductSid);
      if (!profile?.submitted || !product?.submitted) throw new IsvApiError("validation", 400, "20001", "fake: profile and trust product must be submitted");
      const sid = this.sid("BN");
      this.brands.set(sid, { customerProfileSid: input.customerProfileSid, trustProductSid: input.trustProductSid, status: "PENDING", mock: input.mock });
      return sid;
    });
  }

  async getBrandStatus(brandSid: string) {
    return this.guarded("getBrandStatus", { brandSid }, () => this.brands.get(brandSid)?.status ?? "FAILED");
  }

  /** Test helper: the reviewers decided. */
  setBrandStatus(brandSid: string, status: BrandStatus) {
    const brand = this.brands.get(brandSid);
    if (brand) brand.status = status;
  }

  private evaluation(failedFields: string[]): EvaluationResult {
    return failedFields.length > 0 ? { status: "noncompliant", failedFields: [...failedFields] } : { status: "compliant", failedFields: [] };
  }
}
