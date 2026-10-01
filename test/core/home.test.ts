// SUPERSTABLES_HOME arrives from hosts that may not expand shell-style placeholders.
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandHome, homeDir } from "../../src/core/home.js";

const saved = process.env.SUPERSTABLES_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.SUPERSTABLES_HOME;
  else process.env.SUPERSTABLES_HOME = saved;
});

describe("SUPERSTABLES_HOME", () => {
  it("expands ${HOME}, $HOME and ~, with or without a stray leading slash", () => {
    const home = homedir();
    expect(expandHome("${HOME}/.superstables")).toBe(`${home}/.superstables`);
    expect(expandHome("/${HOME}/.superstables")).toBe(`${home}/.superstables`);
    expect(expandHome("$HOME/.superstables")).toBe(`${home}/.superstables`);
    expect(expandHome("~/.superstables")).toBe(`${home}/.superstables`);
    expect(expandHome("/tmp/elsewhere")).toBe("/tmp/elsewhere");
    expect(expandHome("~user/x")).toBe("~user/x");
  });

  it("treats a blank value as unset", () => {
    expect(expandHome("")).toBeUndefined();
    expect(expandHome("   ")).toBeUndefined();
    process.env.SUPERSTABLES_HOME = "";
    expect(homeDir()).toBe(join(homedir(), ".superstables"));
  });

  it("ignores an unexpanded placeholder", () => {
    expect(expandHome("${SUPERSTABLES_HOME}")).toBeUndefined();
    expect(expandHome("/${SUPERSTABLES_HOME}")).toBeUndefined();
    process.env.SUPERSTABLES_HOME = "${SUPERSTABLES_HOME}";
    expect(homeDir()).toBe(join(homedir(), ".superstables"));
  });

  it("resolves an unexpanded ${HOME}", () => {
    process.env.SUPERSTABLES_HOME = "${HOME}/.superstables";
    expect(homeDir()).toBe(join(homedir(), ".superstables"));
  });
});
