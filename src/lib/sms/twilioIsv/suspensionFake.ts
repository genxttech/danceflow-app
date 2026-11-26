import type { ProviderAccount, SubaccountStatusProvider } from "./suspension";
import { IsvApiError } from "./types";

/**
 * TW-4F slice E: in-memory fake of the subaccount status surface, for unit tests and local QA only. It never touches the network. Each account can be
 * scripted to fail its next read or write (definite 4xx, transient, or "applied but the reply was lost").
 */
export type FakeAccount = { sid: string; ownerAccountSid: string | null; status: string };
export type FakeFailure = "definite" | "transient" | "applied_then_transient" | "readback_fails" | "silently_ignored";

export class FakeSubaccountStatusProvider implements SubaccountStatusProvider {
  readonly isFake = true;
  readonly accounts = new Map<string, FakeAccount>();
  readonly writes: { sid: string; status: string }[] = [];
  readonly reads: string[] = [];
  private nextWrite: FakeFailure | null = null;
  private failReadsAfterWrite = false;
  private failNextRead = false;

  add(account: FakeAccount) {
    this.accounts.set(account.sid, { ...account });
    return this;
  }
  failNextWrite(kind: FakeFailure) {
    this.nextWrite = kind;
    if (kind === "readback_fails") this.failReadsAfterWrite = true;
    return this;
  }
  failNextReadOnce() {
    this.failNextRead = true;
    return this;
  }

  async getAccount(accountSid: string): Promise<ProviderAccount> {
    this.reads.push(accountSid);
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new IsvApiError("transient", 503, null, "fake read failure");
    }
    if (this.failReadsAfterWrite && this.writes.length > 0) throw new IsvApiError("transient", null, null, "fake network failure");
    const a = this.accounts.get(accountSid);
    if (!a) throw new IsvApiError("validation", 404, "20404", "fake: not found");
    return { ...a };
  }

  async setStatus(accountSid: string, status: "suspended" | "active"): Promise<void> {
    this.writes.push({ sid: accountSid, status });
    const kind = this.nextWrite;
    this.nextWrite = null;
    const a = this.accounts.get(accountSid);
    if (kind === "definite") throw new IsvApiError("validation", 400, "20001", "fake definite refusal");
    if (kind === "transient") throw new IsvApiError("transient", 503, null, "fake transient");
    if (kind === "silently_ignored") return;
    if (!a) throw new IsvApiError("validation", 404, "20404", "fake: not found");
    if (a.status === "closed") throw new IsvApiError("validation", 400, "20003", "fake: closed");
    a.status = status;
    if (kind === "applied_then_transient") throw new IsvApiError("transient", null, null, "fake reply lost");
  }
}
