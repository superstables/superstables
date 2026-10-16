// budget/keccak.mjs: Keccak-256 in plain JavaScript (Node's crypto has none), against known answers and viem's.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keccak256 as viemKeccak, toBytes } from "viem";
import { keccak256 } from "../../budget/keccak.mjs";

describe("keccak256", () => {
  it("K1: known answers, around the 136-byte block boundary", () => {
    expect(keccak256("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccak256("abc")).toBe("0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    expect(keccak256("a".repeat(136))).toBe("0xa6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e");
    expect(keccak256("a".repeat(137))).toBe("0xd869f639c7046b4929fc92a4d988a8b22c55fbadb802c0c66ebcd484f1915f39");
    expect(keccak256("a".repeat(200))).toBe("0x96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d");
  });

  it("K2: the same as viem's for random byte strings of every length from 0 to 700, and for multi-byte text", () => {
    for (let i = 0; i <= 700; i++) {
      const bytes = randomBytes(i);
      expect(keccak256(bytes)).toBe(viemKeccak(bytes));
    }
    const text = "é€😀".repeat(50);
    expect(keccak256(text)).toBe(viemKeccak(toBytes(text)));
  });

  it("K3: a string and its UTF-8 bytes hash the same", () => {
    expect(keccak256("é€😀")).toBe(keccak256(Buffer.from("é€😀", "utf8")));
  });
});
