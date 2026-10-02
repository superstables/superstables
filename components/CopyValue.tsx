"use client";

import { useState, type ReactNode } from "react";

/** Clipboard API where the browser allows it (https); otherwise the older select-and-copy route. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the fallback */
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  return ok;
}

/**
 * An address (or other value) shown in monospace that copies itself when clicked, with a small
 * copy icon after it that turns into a check once copied. Used for every contract and wallet
 * address on the site, so copying works the same way everywhere.
 */
export default function CopyValue({ value, label = "Copy address", before, className = "" }: {
  value: string;
  label?: string;
  before?: ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`copy-value${copied ? " copied" : ""} ${className}`}
      title={copied ? "Copied" : "Click to copy"}
      aria-label={`${label}: ${value}`}
      onClick={async () => {
        if (await copyText(value)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }
      }}
    >
      {before}
      <span className="copy-value-text mono">{value}</span>
      <svg className="copy-value-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {copied ? (
          <path d="M20 6 9 17l-5-5" />
        ) : (
          <>
            <rect x="9" y="9" width="12" height="12" rx="2" />
            <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
          </>
        )}
      </svg>
      <span className="sr-only" aria-live="polite">{copied ? "Copied" : ""}</span>
    </button>
  );
}
