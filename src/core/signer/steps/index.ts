// The wallet steps the approval page knows, one per SignRequest kind. Adding a rail adds its step here, in one line.

import type { SignKind } from "../types.js";
import { eip3009Step } from "./eip3009.js";
import { tempoStep } from "./tempo.js";
import { solanaStep } from "./solana.js";
import type { WalletStep } from "./types.js";

const STEPS: readonly WalletStep[] = [
  eip3009Step,
  tempoStep,
  solanaStep,
];

/** The step for a kind of sign request, or undefined when the page has none. */
export function stepFor(kind: SignKind): WalletStep | undefined {
  return STEPS.find((step) => step.kind === kind);
}
