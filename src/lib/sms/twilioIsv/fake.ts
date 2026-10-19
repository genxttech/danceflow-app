import { IsvApiError, type BrandStatus, type BundleStatus, type EndUserType, type EvaluationResult, type IsvAdapter, type IsvParentAdapter } from "./types";

/** The account of a FakeIsvAdapter built without one (single-account tests and the MemoryRunnerStore default). */
export const DEFAULT_FAKE_ACCOUNT_SID = `AC${"1".repeat(32)}`;

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
  /** Test seam: a verbatim evaluation reply (even a malformed one) returned instead of the one built from `evaluationFailures`. */
  evaluationRaw: Record<"profile" | "trustProduct", EvaluationResult | null> = { profile: null, trustProduct: null };
  private counter = 0;
  private failures: { method: Method; failure: Failure }[] = [];

  /**
   * @param options.captureSensitive keep the EIN in the recorded calls and end users. OFF by default so a demo/local fake never holds a
   *   plaintext EIN in process memory; the runner's EIN-handling tests turn it on deliberately.
   */
  /** The account this adapter runs in. Resources (and their SIDs) exist only inside one account, like at Twilio. */
  readonly accountSid: string;

  constructor(public readonly primaryProfileSid: string, private readonly options: { captureSensitive?: boolean; primaryPolicySid?: string; accountSid?: string } = {}) {
    this.accountSid = options.accountSid ?? DEFAULT_FAKE_ACCOUNT_SID;
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

  async getTrustProductStatus(trustProductSid: string) {
    return this.guarded("getTrustProductStatus", { trustProductSid }, () => ({ status: this.trustProducts.get(trustProductSid)?.status ?? "unknown" }));
  }

  /** Test helpers: Twilio's reviewers decided about the profile / trust product. */
  setProfileStatus(profileSid: string, status: BundleStatus) {
    const profile = this.profiles.get(profileSid);
    if (profile) profile.status = status;
  }

  setTrustProductStatus(trustProductSid: string, status: BundleStatus) {
    const trustProduct = this.trustProducts.get(trustProductSid);
    if (trustProduct) trustProduct.status = status;
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
      const result = this.evaluationRaw.profile ?? this.evaluation(this.evaluationFailures.profile);
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
    return this.guarded("evaluateTrustProduct", { trustProductSid }, () => ({ evaluationSid: this.sid("EL"), result: this.evaluationRaw.trustProduct ?? this.evaluation(this.evaluationFailures.trustProduct) }));
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

type ParentMethod = keyof IsvParentAdapter;

/**
 * TW-4F-3a: an in-memory stand-in for the PARENT account. It creates subaccounts (each a separate FakeIsvAdapter, so a SID from one account is
 * unknown in another, exactly like Twilio) and hands out fake auth tokens. Like FakeIsvAdapter it can inject failures, including a lost response.
 * ASSUMPTION (Q1b, unverified at Twilio): the ISV Primary profile can be assigned from inside a subaccount, so every fake account knows it.
 */
export class FakeIsvParent implements IsvParentAdapter {
  readonly calls: { method: ParentMethod; input: unknown }[] = [];
  readonly accounts = new Map<string, { friendlyName: string; token: string; adapter: FakeIsvAdapter }>();
  private counter = 0;
  private failures: { method: ParentMethod; failure: { kind: "validation" | "transient" | "account"; lostResponse?: boolean } }[] = [];

  constructor(private readonly primaryProfileSid: string, private readonly options: { primaryPolicySid?: string; captureSensitive?: boolean } = {}) {}

  failNext(method: ParentMethod, failure: { kind: "validation" | "transient" | "account"; lostResponse?: boolean }) {
    this.failures.push({ method, failure });
  }

  count(method: ParentMethod) {
    return this.calls.filter((call) => call.method === method).length;
  }

  private enter(method: ParentMethod, input: unknown) {
    this.calls.push({ method, input });
    const index = this.failures.findIndex((entry) => entry.method === method);
    return index < 0 ? null : this.failures.splice(index, 1)[0].failure;
  }

  private fail(failure: { kind: "validation" | "transient" | "account" }): never {
    throw new IsvApiError(failure.kind, failure.kind === "validation" ? 400 : failure.kind === "account" ? 401 : 503, null, `fake ${failure.kind} failure`);
  }

  /** Test seam: an account that exists "at Twilio" (created outside the app, or by a lost response). */
  seedAccount(accountSid: string, friendlyName: string) {
    const adapter = new FakeIsvAdapter(this.primaryProfileSid, { ...this.options, accountSid });
    this.accounts.set(accountSid, { friendlyName, token: `fake-token-${accountSid.slice(2, 10)}`, adapter });
    return adapter;
  }

  /** The adapter for one account; an unknown SID is created on demand (a dev server process may see SIDs the database recorded earlier). */
  adapterFor(accountSid: string): FakeIsvAdapter {
    return this.accounts.get(accountSid)?.adapter ?? this.seedAccount(accountSid, "fake-seeded");
  }

  async findSubaccount(friendlyName: string) {
    const failure = this.enter("findSubaccount", { friendlyName });
    if (failure) this.fail(failure);
    return [...this.accounts.entries()].filter(([, a]) => a.friendlyName === friendlyName).map(([sid]) => sid);
  }

  async createSubaccount(friendlyName: string) {
    const failure = this.enter("createSubaccount", { friendlyName });
    if (failure && !failure.lostResponse) this.fail(failure);
    this.counter += 1;
    const sid = `AC${"c".repeat(16)}${this.counter.toString(16).padStart(16, "0")}`;
    this.seedAccount(sid, friendlyName);
    if (failure) this.fail(failure);
    return sid;
  }

  async getSubaccountToken(accountSid: string) {
    const failure = this.enter("getSubaccountToken", { accountSid });
    if (failure) this.fail(failure);
    const account = this.accounts.get(accountSid);
    if (!account) throw new IsvApiError("validation", 404, "20404", "fake: subaccount not found");
    return account.token;
  }
}
