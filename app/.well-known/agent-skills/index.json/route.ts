import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { SITE, SKILL_DESCRIPTION, SKILL_MD, SKILL_NAME, SKILL_PATH } from "@/lib/agent-skills";

export const dynamic = "force-static";

/** Agent Skills discovery index (v0.2.0 shape): one skill, the SKILL.md we serve, with its sha256 digest. */
const digest = "sha256:" + createHash("sha256").update(SKILL_MD, "utf8").digest("hex");

const INDEX = {
  $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  name: "Superstables",
  description:
    "The neutral, liveness-probed index of services AI agents can pay with stablecoins across x402, MPP and ACP. Use it when an agent needs to find something it can pay for, check that a payable endpoint is live, or compare rails, chains and prices; do not use it to execute payments.",
  url: SITE,
  skills: [
    {
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      type: "skill-md",
      url: `${SITE}${SKILL_PATH}`,
      digest,
      version: "1.0.0",
    },
  ],
};

export function GET() {
  return NextResponse.json(INDEX, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "s-maxage=3600" } });
}
