import { clientVersion } from "../core/version.js";

const LATEST = "https://registry.npmjs.org/@superstables%2fclient/latest";

function versionParts(version: string): [bigint, bigint, bigint, boolean] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return undefined;
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3]), Boolean(match[4])];
}

export function newerRelease(current: string, latest: string): boolean {
  const a = versionParts(current);
  const b = versionParts(latest);
  if (!a || !b || b[3]) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a[3];
}

/** Only called by interactive doctor; failures never change the result. */
export async function updateNotice(): Promise<string | undefined> {
  if (process.env.SUPERSTABLES_NO_UPDATE_CHECK === "1" || process.env.SUPERSTABLES_DOCTOR_OFFLINE === "1") return;
  try {
    const response = await fetch(LATEST, { signal: AbortSignal.timeout(1000), headers: { accept: "application/json" } });
    if (!response.ok) return;
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null || !("version" in data) || typeof data.version !== "string") return;
    if (newerRelease(clientVersion(), data.version)) {
      return `A newer Superstables client (${data.version}) is available. See https://github.com/superstables/superstables#update-or-remove.`;
    }
  } catch {
    // The check is optional; doctor still reports its own checks.
  }
}
