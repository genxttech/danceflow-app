import { describe, expect, it } from "vitest";

import {
  resolvePortalConnectionState,
  type PortalConnectionLinkRow,
} from "@/lib/student-identity/portal-connection-state";

/**
 * Portal / Multi-Studio H2-A: focused tests for the pure canonical
 * connection-state resolver, written before any call-site changes. No
 * Supabase mocking is used or needed -- every case is a plain row array.
 */

const FIXED_NOW = new Date("2026-08-30T12:00:00.000Z");

function row(overrides: Partial<PortalConnectionLinkRow> & { id: string }): PortalConnectionLinkRow {
  return {
    userId: null,
    status: "linked",
    relationshipType: "self",
    isPrimary: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    inviteTokenHash: null,
    inviteExpiresAt: null,
    ...overrides,
  };
}

describe("resolvePortalConnectionState", () => {
  it("A: exact H1 contradiction -- older linked guardian for U, newer invited self for another identity", () => {
    const rows: PortalConnectionLinkRow[] = [
      row({
        id: "older-guardian",
        userId: "user-u",
        status: "linked",
        relationshipType: "guardian",
        isPrimary: false,
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      row({
        id: "newer-self",
        userId: "user-other",
        status: "invited",
        relationshipType: "self",
        isPrimary: true,
        createdAt: "2026-08-01T00:00:00.000Z",
        inviteTokenHash: "live-token-hash",
        inviteExpiresAt: "2026-09-01T00:00:00.000Z",
      }),
    ];

    const overall = resolvePortalConnectionState({ rows, now: FIXED_NOW });
    expect(overall.kind).toBe("linked");
    expect(overall.kind === "linked" && overall.linkId).toBe("older-guardian");

    const targetU = resolvePortalConnectionState({ rows, targetUserId: "user-u", now: FIXED_NOW });
    expect(targetU.kind).toBe("linked");
    expect(targetU.kind === "linked" && targetU.userId).toBe("user-u");
  });

  it("B: a newer unrelated non-linked row cannot suppress an older active linked relationship", () => {
    const rows: PortalConnectionLinkRow[] = [
      row({ id: "old-linked", userId: "user-a", status: "linked", createdAt: "2026-06-01T00:00:00.000Z" }),
      row({ id: "mid-rejected", userId: "user-b", status: "rejected", createdAt: "2026-07-01T00:00:00.000Z" }),
      row({
        id: "newest-conflict",
        userId: "user-c",
        status: "conflict",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
    ];

    const overall = resolvePortalConnectionState({ rows, now: FIXED_NOW });
    expect(overall.kind).toBe("linked");
    expect(overall.kind === "linked" && overall.linkId).toBe("old-linked");
  });

  it("C: target user with a linked row resolves to linked", () => {
    const rows: PortalConnectionLinkRow[] = [
      row({ id: "u-linked", userId: "user-u", status: "linked", createdAt: "2026-07-01T00:00:00.000Z" }),
    ];

    const state = resolvePortalConnectionState({ rows, targetUserId: "user-u", now: FIXED_NOW });
    expect(state).toMatchObject({ kind: "linked", linkId: "u-linked", userId: "user-u" });
  });

  it("D: target user whose newest relevant row is disconnected resolves to disconnected", () => {
    const rows: PortalConnectionLinkRow[] = [
      row({
        id: "u-disconnected",
        userId: "user-u",
        status: "disconnected",
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
    ];

    const state = resolvePortalConnectionState({ rows, targetUserId: "user-u", now: FIXED_NOW });
    expect(state).toMatchObject({ kind: "disconnected", linkId: "u-disconnected", rawStatus: "disconnected" });
  });

  it("E: a genuine open invite (valid token, unexpired) resolves to invited", () => {
    const rows: PortalConnectionLinkRow[] = [
      row({
        id: "open-invite",
        userId: null,
        status: "invited",
        createdAt: "2026-08-01T00:00:00.000Z",
        inviteTokenHash: "live-token-hash",
        inviteExpiresAt: "2026-09-01T00:00:00.000Z",
      }),
    ];

    const state = resolvePortalConnectionState({ rows, now: FIXED_NOW });
    expect(state).toMatchObject({ kind: "invited", linkId: "open-invite" });
  });

  it("F: an invited row with a cleared (dead) token is inactive, not disconnected -- it was never an active relationship that was revoked", () => {
    const rows: PortalConnectionLinkRow[] = [
      row({
        id: "dead-token-invite",
        userId: null,
        status: "invited",
        createdAt: "2026-08-01T00:00:00.000Z",
        inviteTokenHash: null,
        inviteExpiresAt: null,
      }),
    ];

    const state = resolvePortalConnectionState({ rows, now: FIXED_NOW });
    expect(state.kind).toBe("inactive");
    expect(state.kind === "inactive" && state.rawStatus).toBe("invited");
  });

  it("G: an invited row with an expired token is inactive, not disconnected", () => {
    const rows: PortalConnectionLinkRow[] = [
      row({
        id: "expired-invite",
        userId: null,
        status: "claim_pending",
        createdAt: "2026-07-01T00:00:00.000Z",
        inviteTokenHash: "live-token-hash",
        inviteExpiresAt: "2026-07-08T00:00:00.000Z",
      }),
    ];

    const state = resolvePortalConnectionState({ rows, now: FIXED_NOW });
    expect(state.kind).toBe("inactive");
    expect(state.kind === "inactive" && state.rawStatus).toBe("claim_pending");
  });

  it("G2: a valid token with a null inviteExpiresAt is treated as non-expiring and remains a genuine open invite (matches the implementation's permissive null-expiry handling)", () => {
    const rows: PortalConnectionLinkRow[] = [
      row({
        id: "null-expiry-invite",
        userId: null,
        status: "invited",
        createdAt: "2026-08-01T00:00:00.000Z",
        inviteTokenHash: "live-token-hash",
        inviteExpiresAt: null,
      }),
    ];

    const state = resolvePortalConnectionState({ rows, now: FIXED_NOW });
    expect(state).toMatchObject({ kind: "invited", linkId: "null-expiry-invite" });
  });

  it("a rejected invitation resolves to inactive, not disconnected -- it was never an active relationship", () => {
    const rows: PortalConnectionLinkRow[] = [
      row({ id: "rejected-invite", userId: "user-u", status: "rejected", createdAt: "2026-08-01T00:00:00.000Z" }),
    ];

    const state = resolvePortalConnectionState({ rows, now: FIXED_NOW });
    expect(state.kind).toBe("inactive");
    expect(state.kind === "inactive" && state.rawStatus).toBe("rejected");
  });

  it("a former_client row resolves to disconnected -- disconnectClientAccount's own second terminal status for an explicit revoke", () => {
    const rows: PortalConnectionLinkRow[] = [
      row({ id: "former-client", userId: "user-u", status: "former_client", createdAt: "2026-08-01T00:00:00.000Z" }),
    ];

    const state = resolvePortalConnectionState({ rows, now: FIXED_NOW });
    expect(state.kind).toBe("disconnected");
    expect(state.kind === "disconnected" && state.rawStatus).toBe("former_client");
  });

  it("H: multiple linked relationships -- primary wins over non-primary regardless of recency", () => {
    const rows: PortalConnectionLinkRow[] = [
      row({
        id: "non-primary-newer",
        userId: "user-guardian",
        status: "linked",
        relationshipType: "guardian",
        isPrimary: false,
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      row({
        id: "primary-older",
        userId: "user-self",
        status: "linked",
        relationshipType: "self",
        isPrimary: true,
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
    ];

    const state = resolvePortalConnectionState({ rows, now: FIXED_NOW });
    expect(state).toMatchObject({ kind: "linked", linkId: "primary-older" });
  });

  it("H2: multiple linked relationships, both primary or neither -- oldest wins as the tie-break", () => {
    const rows: PortalConnectionLinkRow[] = [
      row({ id: "newer", userId: "user-a", status: "linked", isPrimary: false, createdAt: "2026-08-01T00:00:00.000Z" }),
      row({ id: "older", userId: "user-b", status: "linked", isPrimary: false, createdAt: "2026-07-01T00:00:00.000Z" }),
    ];

    const state = resolvePortalConnectionState({ rows, now: FIXED_NOW });
    expect(state).toMatchObject({ kind: "linked", linkId: "older" });
  });

  it("I: no rows resolves to none", () => {
    const state = resolvePortalConnectionState({ rows: [], now: FIXED_NOW });
    expect(state).toEqual({ kind: "none" });

    const targetState = resolvePortalConnectionState({ rows: [], targetUserId: "user-u", now: FIXED_NOW });
    expect(targetState).toEqual({ kind: "none" });
  });

  it("target-user mode: an unrelated newer linked row for someone else does not leak into a different target user's scope", () => {
    const rows: PortalConnectionLinkRow[] = [
      row({ id: "other-linked", userId: "user-other", status: "linked", createdAt: "2026-08-01T00:00:00.000Z" }),
    ];

    const state = resolvePortalConnectionState({ rows, targetUserId: "user-u", now: FIXED_NOW });
    expect(state).toEqual({ kind: "none" });
  });

  it("target-user mode: a genuinely open invite for the target user resolves to invited, not disconnected", () => {
    const rows: PortalConnectionLinkRow[] = [
      row({
        id: "u-open-invite",
        userId: "user-u",
        status: "invited",
        createdAt: "2026-08-01T00:00:00.000Z",
        inviteTokenHash: "live-token-hash",
        inviteExpiresAt: "2026-09-01T00:00:00.000Z",
      }),
    ];

    const state = resolvePortalConnectionState({ rows, targetUserId: "user-u", now: FIXED_NOW });
    expect(state).toMatchObject({ kind: "invited", linkId: "u-open-invite" });
  });

  it("a conflict row with no linked/open-invite rows resolves to conflict", () => {
    const rows: PortalConnectionLinkRow[] = [
      row({ id: "the-conflict", userId: "user-u", status: "conflict", createdAt: "2026-08-01T00:00:00.000Z" }),
    ];

    const state = resolvePortalConnectionState({ rows, now: FIXED_NOW });
    expect(state).toMatchObject({ kind: "conflict", linkId: "the-conflict" });
  });
});
