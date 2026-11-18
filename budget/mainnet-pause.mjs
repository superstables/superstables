// The mainnet pause file, registered with the mainnet policy for the plain Node parts of the budget tool (the dispatcher and
// buy-once), which cannot load src/core/mainnet-spend.ts. The same file in the same home folder (paths.mjs HOME follows
// src/core/home.ts), so a pause set for `pay` stops buy-once too. Without a registered check every mainnet reads as paused.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./paths.mjs";
import { setMainnetPauseSource } from "../src/core/mainnet-policy.js";

/** src/core/mainnet-spend.ts MAINNET_PAUSE_FILE. */
export const MAINNET_PAUSE_FILE = "mainnet-paused";

setMainnetPauseSource(() => (existsSync(join(HOME, MAINNET_PAUSE_FILE)) ? `the pause file ${join(HOME, MAINNET_PAUSE_FILE)} exists` : ""));
