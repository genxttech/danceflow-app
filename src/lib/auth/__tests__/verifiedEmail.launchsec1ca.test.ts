import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const sendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

const {
  completePasswordBinding,
  recordEmailProof,
  revokeOtherSessions,
  sendEmailVerificationLink,
  getEmailBindingStatus,
} = await import("../verifiedEmail");

type Call = { step: string; args: unknown[] };

function buildClients(options: {
  claims?: Record<string, unknown> | null;
  status?: string;
  revokeError?: boolean;
  updateError?: { code?: string } | null;
  bound?: boolean;
}) {
  const calls: Call[] = [];
  const record = (step: string, ...args: unknown[]) => calls.push({ step, args });

  const userClient = {
    rpc: vi.fn(async (fn: string) => {
      record(`user.rpc:${fn}`);
      return { data: options.status ?? "binding_ready", error: null };
    }),
  };

  const adminClient = {
    auth: {
      getClaims: vi.fn(async (token: string) => {
        record("admin.getClaims", token);
        return options.claims === null
          ? { data: null, error: { message: "bad" } }
          : { data: { claims: options.claims ?? { sub: "user-1", session_id: "session-1" } }, error: null };
      }),
      admin: {
        signOut: vi.fn(async (token: string, scope: string) => {
          record("admin.signOut", token, scope);
          return { error: options.revokeError ? { code: "x" } : null };
        }),
        updateUserById: vi.fn(async (id: string, attrs: Record<string, unknown>) => {
          record("admin.updateUserById", id, Object.keys(attrs));
          return options.updateError
            ? { data: { user: null }, error: options.updateError }
            : { data: { user: { id, email: "Owner@Example.com" } }, error: null };
        }),
        generateLink: vi.fn(),
      },
    },
    rpc: vi.fn(async (fn: string, args: unknown) => {
      record(`admin.rpc:${fn}`, args);
      return { data: options.bound ?? true, error: null };
    }),
  };

  return { calls, userClient, adminClient };
}

function bind(clients: ReturnType<typeof buildClients>, password = "correct-horse-9") {
  return completePasswordBinding({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    userClient: clients.userClient as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adminClient: clients.adminClient as any,
    accessToken: "proof-access-token",
    password,
  });
}

describe("LAUNCH-SEC-1C-A completePasswordBinding", () => {
  it("binds in the exact fail-closed order: verify, readiness, revoke, admin password, then bound", async () => {
    const clients = buildClients({});
    const result = await bind(clients);

    expect(result).toEqual({ ok: true, email: "owner@example.com" });
    expect(clients.calls.map((call) => call.step)).toEqual([
      "admin.getClaims",
      "user.rpc:email_binding_status",
      "admin.signOut",
      "admin.updateUserById",
      "admin.rpc:complete_email_binding",
    ]);
    expect(clients.calls[2].args).toEqual(["proof-access-token", "others"]);
    expect(clients.calls[3].args).toEqual(["user-1", ["password"]]);
    expect(clients.calls[4].args).toEqual([{ p_user_id: "user-1", p_session_id: "session-1" }]);
  });

  it.each(["binding_required", "unproven", "bound", "no_session", "unavailable"])(
    "a session that is not the fresh proof session (%s) cannot bind or touch the password",
    async (status) => {
      const clients = buildClients({ status });
      expect(await bind(clients)).toEqual({ ok: false, code: "not_ready" });
      expect(clients.calls.map((call) => call.step)).not.toContain("admin.updateUserById");
      expect(clients.calls.map((call) => call.step)).not.toContain("admin.rpc:complete_email_binding");
    },
  );

  it("revocation failure stays blocked: no password change, no bound transition", async () => {
    const clients = buildClients({ revokeError: true });
    expect(await bind(clients)).toEqual({ ok: false, code: "revoke_failed" });
    expect(clients.calls.map((call) => call.step)).not.toContain("admin.updateUserById");
    expect(clients.calls.map((call) => call.step)).not.toContain("admin.rpc:complete_email_binding");
  });

  it("password replacement failure never marks the identity bound", async () => {
    const clients = buildClients({ updateError: { code: "unexpected_failure" } });
    expect(await bind(clients)).toEqual({ ok: false, code: "password_update_failed" });
    expect(clients.calls.map((call) => call.step)).not.toContain("admin.rpc:complete_email_binding");
  });

  it("maps a provider weak-password rejection", async () => {
    const clients = buildClients({ updateError: { code: "weak_password" } });
    expect(await bind(clients)).toEqual({ ok: false, code: "weak_password" });
  });

  it("a bound transition rejected by the database is reported as expired (recoverable)", async () => {
    const clients = buildClients({ bound: false });
    expect(await bind(clients)).toEqual({ ok: false, code: "bind_expired" });
  });

  it("short passwords and unverifiable tokens make no provider calls", async () => {
    const weak = buildClients({});
    expect(await bind(weak, "short")).toEqual({ ok: false, code: "weak_password" });
    expect(weak.calls).toEqual([]);

    const unverified = buildClients({ claims: null });
    expect(await bind(unverified)).toEqual({ ok: false, code: "not_authenticated" });
    expect(unverified.calls.map((call) => call.step)).toEqual(["admin.getClaims"]);

    const noSession = buildClients({ claims: { sub: "user-1" } });
    expect(await bind(noSession)).toEqual({ ok: false, code: "not_authenticated" });
  });
});

describe("LAUNCH-SEC-1C-A proof and status helpers", () => {
  it("records proof through the argument-free RPC for the source and passes nothing else", async () => {
    const rpc = vi.fn(async () => ({ data: "binding_required", error: null }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await recordEmailProof({ rpc } as any, "web")).toBe("binding_required");
    expect(rpc).toHaveBeenCalledWith("record_email_proof_web");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await recordEmailProof({ rpc } as any, "mobile")).toBe("binding_required");
    expect(rpc).toHaveBeenLastCalledWith("record_email_proof_mobile");
  });

  it("treats any other database answer or error as not recorded", async () => {
    const rejected = vi.fn(async () => ({ data: "no_fresh_mailbox_auth", error: null }));
    const failing = vi.fn(async () => ({ data: null, error: { code: "42501" } }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await recordEmailProof({ rpc: rejected } as any, "web")).toBe("not_recorded");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await recordEmailProof({ rpc: failing } as any, "web")).toBe("not_recorded");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await getEmailBindingStatus({ rpc: failing } as any)).toBe("unavailable");
  });

  it("revokes other sessions with the proof token only", async () => {
    const signOut = vi.fn(async () => ({ error: null }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = { auth: { admin: { signOut } } } as any;
    expect(await revokeOtherSessions(admin, "tok")).toBe(true);
    expect(signOut).toHaveBeenCalledWith("tok", "others");
    expect(await revokeOtherSessions(admin, "")).toBe(false);
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

describe("LAUNCH-SEC-1C-A verification email", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.RESEND_API_KEY = "test-resend-key";
  });

  it("sends a token_hash /callback link to exactly the given address", async () => {
    sendMock.mockResolvedValue({ data: { id: "m1" }, error: null });
    const generateLink = vi.fn(async () => ({
      data: { properties: { hashed_token: "hash-123", verification_type: "magiclink" } },
      error: null,
    }));

    const ok = await sendEmailVerificationLink({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminClient: { auth: { admin: { generateLink } } } as any,
      email: " Current@Example.com ",
      baseUrl: "https://app.example",
      nextPath: "/account/verify-email",
      purpose: "verify",
    });

    expect(ok).toBe(true);
    expect(generateLink).toHaveBeenCalledWith({ type: "magiclink", email: "current@example.com", options: undefined });
    const message = sendMock.mock.calls[0][0];
    expect(message.to).toEqual(["current@example.com"]);
    expect(message.text).toContain(
      "https://app.example/callback?token_hash=hash-123&type=magiclink&next=%2Faccount%2Fverify-email",
    );
  });

  it("does not send when the link cannot be generated", async () => {
    const generateLink = vi.fn(async () => ({ data: null, error: { code: "x" } }));
    const ok = await sendEmailVerificationLink({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminClient: { auth: { admin: { generateLink } } } as any,
      email: "a@example.com",
      baseUrl: "https://app.example",
      nextPath: "/account",
      purpose: "signup",
    });
    expect(ok).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
