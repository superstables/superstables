// A request the owner page could not handle is answered with a plain sentence. What went wrong (it can name files and
// internal state) goes to the command's error output, not to the browser.
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerApprovalServer } from "../../src/core/signer/owner-approval-server.js";

let server: OwnerApprovalServer | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

describe("the owner page's 500", () => {
  it("does not carry the error's message", async () => {
    server = new OwnerApprovalServer({ port: 0 });
    await server.start();
    (server as unknown as { handle: unknown }).handle = async () => {
      throw new Error("EACCES /home/someone/.superstables/x");
    };
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as never);
    const res = await fetch(`${server.url}/`);
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "the owner page could not handle that request; the command's error output says why" });
    expect(text).not.toContain("/home/someone");
    expect(written.join("")).toContain("owner page: a request failed: EACCES /home/someone");
  });
});
