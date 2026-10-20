// Everything a command needs to read and write this machine's payment state, with the owner's policy and
// the signer the command was started with. Built after --home and --wallet have been applied.

import { recordsDir } from "../core/home.js";
import { PaymentEngine } from "../core/pay.js";
import { loadPaymentPolicy, type Policy } from "../core/policy.js";
import { Records } from "../core/records.js";
import type { Signer } from "../core/signer/types.js";
import type { WalletStatus } from "../core/types.js";
import { signerFor } from "./signer.js";

export interface PaymentContext {
  records: Records;
  policy: Policy;
  engine: PaymentEngine;
  signer: Signer & { status(): Promise<WalletStatus> };
}

export function paymentContext(): PaymentContext {
  const records = new Records(recordsDir());
  const policy = loadPaymentPolicy();
  const signer = signerFor();
  return { records, policy, engine: new PaymentEngine({ records, policy, signer }), signer };
}
