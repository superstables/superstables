// Where superstables budget keeps keys and state. Every rail and the CLI import this file; no other file names a path.
// The home is the client's: SUPERSTABLES_HOME (a leading ~, $HOME or ${HOME} is expanded; blank means the default),
// else ~/.superstables. Same rule as src/core/home.ts.
//
//   $SUPERSTABLES_HOME/keys/budget/<rail>-owner.env    owner key (mode 600). Owner commands only.
//   $SUPERSTABLES_HOME/keys/budget/<rail>-agent.env    agent key (mode 600). Agent commands only.
//   $SUPERSTABLES_HOME/budget/public/<rail>-<chain>.env   public addresses and budget terms, no secret.
//   $SUPERSTABLES_HOME/budget/ops/<rail>-<chain>/<id>.json   one journal per purchase.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function expandHome(value) {
  const raw = (value ?? "").trim();
  if (raw === "") return undefined;
  if (/\$\{[^}]*\}/.test(raw.replace(/^\/?\$\{HOME\}/, ""))) return undefined;
  const home = homedir();
  return raw.replace(/^\/?\$\{HOME\}/, home).replace(/^\/?\$HOME(?=\/|$)/, home).replace(/^~(?=\/|$)/, home);
}

export const HOME = resolve(expandHome(process.env.SUPERSTABLES_HOME) ?? join(homedir(), ".superstables"));
export const KEYS_DIR = join(HOME, "keys", "budget");
export const STATE_DIR = join(HOME, "budget");
export const ownerKeyFile = (rail) => join(KEYS_DIR, `${rail}-owner.env`);
export const agentKeyFile = (rail) => join(KEYS_DIR, `${rail}-agent.env`);
export const publicFile = (rail, chain) => join(STATE_DIR, "public", `${rail}-${chain}.env`);
export const opsDir = (rail, chain) => join(STATE_DIR, "ops", `${rail}-${chain}`);
