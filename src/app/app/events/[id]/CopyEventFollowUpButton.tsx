"use client";

import { useState } from "react";

type CopyEventFollowUpButtonProps = {
  subject: string;
  body: string;
  className?: string;
};

export default function CopyEventFollowUpButton({
  subject,
  body,
  className,
}: CopyEventFollowUpButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const text = `Subject: ${subject}\n\n${body}`;

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (error) {
      console.error("Failed to copy ARIA follow-up draft", error);
      setCopied(false);
    }
  }

  return (
    <button type="button" onClick={handleCopy} className={className}>
      {copied ? "Copied" : "Copy message"}
    </button>
  );
}
