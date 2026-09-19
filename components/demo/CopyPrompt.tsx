"use client";

import { useId, useState } from "react";
import { demoPage } from "@/content/demo";

const q = demoPage.setup.quote;

type CopyState = "idle" | "copied" | "failed";

/** The example prompt with a copy action. A failed copy shows the fallback instruction in place of the hidden status. */
export default function CopyPrompt() {
  const [state, setState] = useState<CopyState>("idle");
  const promptId = useId();

  async function copy() {
    try {
      await navigator.clipboard.writeText(q.prompt);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <>
      <div className="prompt">
        <div className="prompt-head">
          <button type="button" className="copy" onClick={copy} aria-describedby={promptId}>
            {state === "copied" ? (
              <>
                {q.copied} <span aria-hidden="true">✓</span>
              </>
            ) : (
              <>
                {q.copy} <span aria-hidden="true">⧉</span>
              </>
            )}
          </button>
        </div>
        <p className="prompt-text" id={promptId}>
          {q.prompt}
        </p>
      </div>
      <p className={state === "failed" ? "copy-status" : "copy-status sr-only"} aria-live="polite">
        {state === "copied" && q.copiedStatus}
        {state === "failed" && q.copyFailed}
      </p>
    </>
  );
}
