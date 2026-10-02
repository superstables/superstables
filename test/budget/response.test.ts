// What a tempo or solana purchase bought: the seller's answer, read up to 1 MB and saved next to the journal (mode 600).

import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_RESPONSE_BYTES, readCapped, saveResponse } from "../../budget/response.mjs";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "superstables-response-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the seller's answer to a purchase", () => {
  it("is saved byte for byte as <op>.response, mode 600, with its type and size for RESULT", async () => {
    const body = await readCapped(new Response('{"jsonrpc":"2.0","id":1,"result":"0x241522d"}'));
    const saved = saveResponse(join(dir, "ops"), "qn-1", body, "application/json; charset=utf-8", () => {});
    expect(saved).toEqual({ responseFile: join(dir, "ops", "qn-1.response"), responseType: "application/json; charset=utf-8", responseBytes: 45, responseTruncated: false });
    expect(readFileSync(saved!.responseFile, "utf8")).toBe('{"jsonrpc":"2.0","id":1,"result":"0x241522d"}');
    expect(statSync(saved!.responseFile).mode & 0o777).toBe(0o600);
  });

  it("keeps at most 1 MB and says it was cut", async () => {
    const body = await readCapped(new Response(Buffer.alloc(MAX_RESPONSE_BYTES + 10, 97)));
    expect(body.bytes.length).toBe(MAX_RESPONSE_BYTES);
    expect(body.truncated).toBe(true);
    expect(saveResponse(dir, "big", body, null, () => {})).toMatchObject({ responseBytes: MAX_RESPONSE_BYTES, responseTruncated: true, responseType: null });
  });

  it("never writes through a link planted in its place, and reports nothing saved instead", async () => {
    symlinkSync(join(dir, "elsewhere"), join(dir, `x.response.${process.pid}.tmp`));
    const saved = saveResponse(dir, "x", await readCapped(new Response("data")), "text/plain", () => {});
    expect(saved).toBeNull();
  });
});
