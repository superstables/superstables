// The two lists the plugin build, the skill text and their tests all read.
//
// PLUGIN_ZIPS: one row per app that installs from a downloaded plugin zip. `layout` says what the zip holds:
//   marketplace  .claude-plugin/marketplace.json and plugin/ (the repository's marketplace layout)
//   claude-root  the plugin root for the Claude apps: .claude-plugin/plugin.json and nothing else that names a manifest
//   cursor-root  the plugin root for Cursor's local import: plugin.json (Agent Plugin layout) and mcp.json
// OPERATIONS: where each operation runs. `connector` ones need no signature from this machine and go through the
// Superstables connector (the tool names are the server's, from tools/list at https://mcp.superstables.com).
// `cli` ones need the agent key on this machine and stay on the CLI.

export const PLUGIN_ZIPS = [
  { app: "claude-code", label: "Claude Code", layout: "marketplace" },
  { app: "codex", label: "Codex", layout: "marketplace" },
  { app: "claude-apps", label: "Claude apps", layout: "claude-root" },
  { app: "cursor", label: "Cursor", layout: "cursor-root" },
];

// The one source for how the plugin is listed. scripts/plugin-sync.mjs writes it into every manifest, the marketplace
// entry and the skill's agents/openai.yaml, and `plugin:check` fails when one differs. Icons are the Superstables mark from
// the website's app/icon.svg (plugin/assets/icon.svg, rendered to icon.png).
export const PLUGIN_LISTING = {
  name: "superstables",
  displayName: "Superstables",
  shortDescription: "Find paid services and request single purchases that you approve. Testnet only.",
  longDescription:
    "Superstables lets your agent find services that charge per request and read what they cost. In an app with a terminal, Budgets let you approve a total spending limit in your wallet, on your machine or on superstables.com. The agent can then spend within that limit without approval for each purchase. You can revoke the budget by signing a transaction in your wallet. For a single purchase through the connector, an account member approves and signs in their wallet on superstables.com before payment. Testnet only: test tokens, no real money.",
  marketplaceDescription: "Superstables tools and skills for finding services and paying with test tokens.",
  developerName: "Superstables",
  category: "Payments",
  homepage: "https://www.superstables.com",
  repository: "https://github.com/superstables/superstables",
  license: "Apache-2.0",
  keywords: ["payments", "services", "mcp", "cli", "testnet"],
  brandColor: "#CBFF00",
  // Paths relative to plugin/. The skill keeps its own copies (plugin-sync copies and checks them) because openai.yaml paths are relative to the skill.
  icon: "assets/icon.png",
  skillIcons: { small: "assets/icon-small.svg", large: "assets/icon-large.png" },
};

export const zipName = (app, version) => `superstables-plugin-${app}-${version}.zip`;

// The connector tools and the waiting rule are not listed here: the server owns them (test/scripts/connector-contract.json is a generated copy).
// CLI commands that need a signature from this machine. Each is a substring the skill's CLI text must mention.
export const LOCAL_ONLY = ["--sign-only", "budget buy", "pay", "recover", "reconcile"];

// CLI forms that have a connector tool and so must not be what the skill sends a signed-in person to.
export const CLI_FORMS_WITH_TOOLS = {
  "budget find": "find_budget_services",
  "budget preflight": "preflight_budget_purchase",
};
