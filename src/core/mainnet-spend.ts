// The mainnet boundary at the moment of signing and sending, and the pause file it reads. Right before a key or a wallet
// is asked to sign on a mainnet, and right before a signature made on one is sent, the network mode, the mainnet
// manifest and the pause are read again (./mainnet-policy.js): a switch turned off or a pause set while the owner was
// signing stops what comes next. There are no caps here: the owner's spend policy and budgets set how much may move.
//
// The pause file lives in the client's home folder. While it exists, or while SUPERSTABLES_MAINNET_PAUSE is set, nothing
// new is signed or sent on a mainnet (./mainnet-policy.js says what a pause cannot undo). Testnets never touch any of this.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "./home.js";
import { mainnetRefusal, setMainnetPauseSource, type MainnetManifest } from "./mainnet-policy.js";

export const MAINNET_PAUSE_FILE = "mainnet-paused";

setMainnetPauseSource(() => (existsSync(join(homeDir(), MAINNET_PAUSE_FILE)) ? `the pause file ${join(homeDir(), MAINNET_PAUSE_FILE)} exists` : ""));

/** A refusal at the mainnet boundary: nothing was signed or sent. */
export class MainnetRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MainnetRefused";
  }
}

export interface MainnetChainRef {
  rail: string;
  key: string;
  chainId?: number;
  testnet: unknown;
  token?: unknown;
}

/**
 * Why nothing may be signed or sent on `chain` right now, or "": the network mode, the manifest and the pause, read
 * at this moment. A signature kept back is never sent by this client; it stays valid on chain until it expires.
 */
export function mainnetSendRefusal(chain: MainnetChainRef, opts: { manifest?: MainnetManifest; env?: Record<string, string | undefined> } = {}): string {
  if (chain.testnet === true) return "";
  return mainnetRefusal(chain, opts.manifest, opts.env);
}
