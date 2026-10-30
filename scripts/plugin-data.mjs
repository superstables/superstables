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

export const zipName = (app, version) => `superstables-plugin-${app}-${version}.zip`;

export const CONNECTOR_TOOLS = [
  "get_my_account",
  "find_services",
  "request_purchase",
  "get_purchase_status",
  "find_budget_services",
  "preflight_budget_purchase",
  "list_my_budgets",
  "get_budget_status",
  "get_budget_request",
  "wait_budget_request",
  "request_budget_revoke",
  "remove_budget_agent",
  "submit_budget_request",
];

// CLI commands that need a signature from this machine. Each is a substring the skill's CLI text must mention.
export const LOCAL_ONLY = ["--sign-only", "budget buy", "pay", "recover", "reconcile"];

// CLI forms that have a connector tool and so must not be what the skill sends a signed-in person to.
export const CLI_FORMS_WITH_TOOLS = {
  "budget find": "find_budget_services",
  "budget preflight": "preflight_budget_purchase",
};
