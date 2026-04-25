"use client";

import { useMemo, useState } from "react";

type Props = {
  email: string;
};

export default function CopyInviteLinkButton({ email }: Props) {
  const [copied, setCopied] = useState(false);

    const inviteLink = useMemo(() => {
    if (typeof window === "undefined") return "";
    const url = new URL("/invite", window.location.origin);
    url.searchParams.set("next", "/app");
    url.searchParams.set("email", email);
    return url.toString();
  }, [email]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
    >
      {copied ? "Copied Invite Link" : "Copy Invite Link"}
    </button>
  );
}