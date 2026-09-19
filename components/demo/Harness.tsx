"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { DEFAULT_APP, demoApps, demoPage, type DemoAppId } from "@/content/demo";

/**
 * The one piece of interactive state on /demo: which app the reader set up. The picker,
 * the step 1 panel and the app name in step 3 read it from context, so the page markup
 * around them stays server-rendered. Setup snippets are text; nothing here runs them.
 */

type Harness = { appId: DemoAppId; choose: (value: string) => void; announced: string };

const HarnessContext = createContext<Harness | null>(null);

function useHarness(): Harness {
  const ctx = useContext(HarnessContext);
  if (!ctx) throw new Error("Harness components must be rendered inside HarnessProvider");
  return ctx;
}

function isAppId(value: string): value is DemoAppId {
  return demoApps.some((a) => a.id === value);
}

export function HarnessProvider({ children }: { children: ReactNode }) {
  const [appId, setAppId] = useState<DemoAppId>(DEFAULT_APP);
  const [announced, setAnnounced] = useState("");
  function choose(value: string) {
    if (!isAppId(value)) return;
    setAppId(value);
    const name = demoApps.find((a) => a.id === value)?.name ?? value;
    setAnnounced(demoPage.harness.announce(name));
  }
  return <HarnessContext.Provider value={{ appId, choose, announced }}>{children}</HarnessContext.Provider>;
}

/** Native radios: arrow keys move the choice and focus stays on the selected radio. The change is announced politely. */
export function AppPicker() {
  const { appId, choose, announced } = useHarness();
  return (
    <>
      <fieldset className="app-picker">
        <legend className="sr-only">{demoPage.harness.legend}</legend>
        {demoApps.map((a) => (
          <label key={a.id} className="app-option">
            <input type="radio" name="demo-app" value={a.id} checked={a.id === appId} onChange={(e) => choose(e.target.value)} />
            <span>{a.name}</span>
          </label>
        ))}
      </fieldset>
      <p className="app-note">{demoPage.harness.note}</p>
      <p className="sr-only" aria-live="polite">
        {announced}
      </p>
    </>
  );
}

/** Step 1 for the chosen app, plus the client build instructions for apps that need them. */
export function AppPanel() {
  const { appId } = useHarness();
  const app = demoApps.find((a) => a.id === appId) ?? demoApps[0];
  const build = demoPage.setup.build;
  return (
    <>
      <div className="app-panel">
        <h3>{app.title}</h3>
        <p>{app.intro}</p>
        {app.code !== null && (
          <pre tabIndex={0} aria-label={`${app.name} MCP configuration`}>
            <code>{app.code}</code>
          </pre>
        )}
        <p>{app.after}</p>
        <a className="text-link config-guide" href={app.url}>
          {app.name} setup guide <span aria-hidden="true">↗</span>
        </a>
      </div>
      {app.code !== null && (
        <details className="build-client">
          <summary>{build.summary}</summary>
          <p>{build.intro}</p>
          <pre tabIndex={0} aria-label={build.label}>
            <code>{build.code}</code>
          </pre>
          <p>{build.after}</p>
        </details>
      )}
    </>
  );
}

/** The chosen app's name, inline in step 3. */
export function ChosenAppName() {
  const { appId } = useHarness();
  return <span>{demoApps.find((a) => a.id === appId)?.name ?? demoApps[0].name}</span>;
}
