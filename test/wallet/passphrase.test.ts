import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { askHidden, askNewPassphrase, canAsk } from "../../src/wallet/passphrase.js";

/** A terminal that is not one: a stream with isTTY, a raw-mode switch to record, and a place to type. */
function fakeTerminal() {
  const input = new EventEmitter() as EventEmitter & { isTTY: boolean; raw: boolean[]; setRawMode(on: boolean): void; resume(): void; pause(): void };
  input.isTTY = true;
  input.raw = [];
  input.setRawMode = (on) => void input.raw.push(on);
  input.resume = () => undefined;
  input.pause = () => undefined;
  let written = "";
  const output = { isTTY: true, write: (text: string) => ((written += text), true) };
  const type = (text: string) => input.emit("data", Buffer.from(text));
  return { input: input as never, output: output as never, type, raw: input.raw, written: () => written };
}

describe("askHidden", () => {
  it("returns what was typed, with backspace, and echoes nothing", async () => {
    const t = fakeTerminal();
    const answer = askHidden("Passphrase: ", { input: t.input, output: t.output });
    t.type("a");
    t.type("x");
    t.type("\x7f");
    t.type("\x1b[D"); // an arrow key is not text
    t.type("bc\r");
    expect(await answer).toBe("abc");
    expect(t.written()).toBe("Passphrase: \n"); // the prompt, and the line end: nothing typed
    expect(t.raw).toEqual([true, false]);
  });

  it("is cancelled by Ctrl-C and puts the terminal back", async () => {
    const t = fakeTerminal();
    const answer = askHidden("Passphrase: ", { input: t.input, output: t.output });
    t.type("ab\x03");
    await expect(answer).rejects.toThrow("cancelled");
    expect(t.raw).toEqual([true, false]);
  });

  it("normalises the text, so one passphrase typed on two keyboards is one passphrase", async () => {
    const t = fakeTerminal();
    const answer = askHidden("P: ", { input: t.input, output: t.output });
    t.type("é\n");
    expect(await answer).toBe("é");
  });
});

describe("askNewPassphrase", () => {
  it("refuses 11 characters and a mismatch, and accepts two matching long ones", async () => {
    const t = fakeTerminal();
    const answer = askNewPassphrase({ input: t.input, output: t.output });
    const typeLine = async (text: string) => {
      await new Promise((r) => setTimeout(r, 0));
      t.type(`${text}\r`);
    };
    await typeLine("elevenchars"); // 11 characters: refused, asks again from the start
    await typeLine("twelve chars");
    await typeLine("twelve chars?"); // does not match
    await typeLine("a long passphrase");
    await typeLine("a long passphrase");
    expect(await answer).toBe("a long passphrase");
    expect(t.written()).toMatch(/at least 12 characters/);
    expect(t.written()).toMatch(/do not match/);
  });

  it("gives up after three tries", async () => {
    const t = fakeTerminal();
    const answer = askNewPassphrase({ input: t.input, output: t.output });
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      t.type("short\r");
    }
    await expect(answer).rejects.toThrow(/too many tries/);
  });
});

describe("canAsk", () => {
  it("needs a terminal on both ends", () => {
    const t = fakeTerminal();
    expect(canAsk({ input: t.input, output: t.output })).toBe(true);
    expect(canAsk({ input: { ...(t.input as object), isTTY: false } as never, output: t.output })).toBe(false);
    expect(canAsk({ input: t.input, output: { isTTY: false } as never })).toBe(false);
  });
});
