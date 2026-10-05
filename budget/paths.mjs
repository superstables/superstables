// Where superstables budget keeps keys and state. Every rail and the CLI import this file; record file names are composed under these directories.
// The home is the client's: SUPERSTABLES_HOME (a leading ~, $HOME or ${HOME} is expanded; blank means the default),
// else ~/.superstables. Same rule as src/core/home.ts.
//
//   No owner key file on any rail: the owner approves in their own wallet. (ownerKeyFile names the old path, which doctor
//   only notes when it finds one; owner commands read an owner key only from --owner-key-file, in tests.)
//   $SUPERSTABLES_HOME/keys/budget/<rail>-agent.env    agent key (mode 600). Agent commands only.
//   $SUPERSTABLES_HOME/budget/public/<rail>-<chain>.env   public addresses and budget terms, no secret.
//   $SUPERSTABLES_HOME/budget/ops/<rail>-<chain>/<id>.json   one journal per purchase.
//   $SUPERSTABLES_HOME/budget/owner-approvals.jsonl          one line per owner page state change (no signatures).
//   $SUPERSTABLES_HOME/budget/approvals/<id>.json and .log  one detached owner approval: its record and its process log.
//   $SUPERSTABLES_HOME/budget/once/attributed-<rail>-<chain>-<tx>.json   durable [site, purchase id] claim, mode 600; no token.
//   $SUPERSTABLES_HOME/budget/once/attributed-<rail>-<chain>-<tx>.json.<pid>.<uuid>.tmp   unpublished claim; cleaned safely on read.
//   $SUPERSTABLES_HOME/budget/once/<id>.response            what a buy-once purchase returned (seller data, mode 600).
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
export const ownerApprovalsLog = () => join(STATE_DIR, "owner-approvals.jsonl");
export const approvalsDir = () => join(STATE_DIR, "approvals");
export const onceDir = () => join(STATE_DIR, "once");
