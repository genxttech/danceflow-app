"use client";

import { useEffect, useMemo } from "react";

function buildDanceFlowDeepLink() {
  if (typeof window === "undefined") return null;

  const params = new URLSearchParams(window.location.search);
  const tokenHash = params.get("token_hash");
  const type = params.get("type") || "magiclink";

  if (!tokenHash) return null;

  const nextParams = new URLSearchParams({
    token_hash: tokenHash,
    type
  });

  return `danceflow://auth/callback?${nextParams.toString()}`;
}

export default function MobileCallbackPage() {
  const deepLink = useMemo(() => buildDanceFlowDeepLink(), []);

  useEffect(() => {
    if (!deepLink) return;

    window.location.href = deepLink;
  }, [deepLink]);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        fontFamily:
          'Arial, "Helvetica Neue", Helvetica, system-ui, sans-serif',
        background: "#f8fafc",
        color: "#0f172a"
      }}
    >
      <section
        style={{
          width: "100%",
          maxWidth: 520,
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: 16,
          padding: 28,
          textAlign: "center",
          boxShadow: "0 18px 45px rgba(15, 23, 42, 0.08)"
        }}
      >
        <p
          style={{
            margin: "0 0 10px",
            color: "#6d28d9",
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: 2,
            textTransform: "uppercase"
          }}
        >
          DanceFlow Secure Access
        </p>
        <h1 style={{ margin: "0 0 12px", fontSize: 28, lineHeight: 1.2 }}>
          Opening DanceFlow
        </h1>
        <p style={{ margin: "0 0 20px", color: "#475569", lineHeight: 1.6 }}>
          If the app does not open automatically, use the button below.
        </p>

        {deepLink ? (
          <a
            href={deepLink}
            style={{
              display: "inline-block",
              background: "#6d28d9",
              color: "#ffffff",
              borderRadius: 10,
              padding: "12px 18px",
              textDecoration: "none",
              fontWeight: 700
            }}
          >
            Open DanceFlow
          </a>
        ) : (
          <p style={{ color: "#dc2626", lineHeight: 1.6 }}>
            This sign-in link is missing required information. Request a fresh
            magic link.
          </p>
        )}
      </section>
    </main>
  );
}
