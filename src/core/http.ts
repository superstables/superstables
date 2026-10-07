// Reading an answer from somebody else's server: no further than a cap, no later than a deadline, and saying how the
// read ended. Every exchange with a seller and every chain read goes through here (x402.ts, pay.ts, rpc.ts).

/** How long the free challenge exchange may take, start to finish, and how much of the answer is read. */
export const DETECT_TIMEOUT_MS = 15_000;
export const MAX_CHALLENGE_BYTES = 1_000_000;

/** A service that did not finish answering in time. Its socket has been released. */
export class DeadlineError extends Error {
  constructor(url: string, ms: number) {
    super(`${hostLabel(url)} did not finish answering within ${Math.round(ms / 100) / 10} s`);
    this.name = "DeadlineError";
  }
}

export function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the service";
  }
}

/** How a capped read ended: the body's end was seen, the cap or drain limit was reached, the deadline passed, or the read failed. */
export type ReadEnd = "eof" | "cap" | "deadline" | "error";

/**
 * Read a response body as text, keeping no more than `max` bytes and reading no later than `ms` from now, and say how
 * the read ended. With `drainTo`, reading goes on past `max` without keeping anything, up to `drainTo` bytes in all, so
 * that an answer longer than what is kept can still be seen to end ("eof"). The reader is always cancelled afterwards,
 * which releases the socket. Never throws.
 */
export async function readBody(
  res: Response,
  max: number,
  ms: number,
  drainTo = max,
): Promise<{ text: string; end: ReadEnd }> {
  const body = res.body;
  if (!body) return { text: "", end: "eof" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let seen = 0;
  let end: ReadEnd = "eof";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), Math.max(0, ms));
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), late]);
      if (next === "deadline") {
        end = "deadline";
        break;
      }
      if (next.done) break;
      const value = next.value;
      if (!value) continue;
      seen += value.length;
      if (kept < max) {
        chunks.push(value);
        kept += value.length;
      }
      if (seen >= drainTo) {
        end = "cap";
        break;
      }
    }
  } catch {
    end = "error";
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => undefined);
  }
  return { text: Buffer.concat(chunks).subarray(0, max).toString("utf8"), end };
}

/**
 * Read a response body as text, no further than `max` bytes and no later than `ms` from now. Past the cap the transfer
 * stops; past the deadline the read is cancelled and this throws DeadlineError. A service that sends a byte at a time
 * forever is the case the deadline is for: a timeout on the request alone does not end a body that keeps arriving.
 */
export async function readCapped(res: Response, max: number, ms = DETECT_TIMEOUT_MS, url = res.url): Promise<string> {
  const { text, end } = await readBody(res, max, ms);
  if (end === "deadline") throw new DeadlineError(url, ms);
  if (end === "error") throw new Error(`the answer from ${hostLabel(url)} broke off`);
  return text;
}
