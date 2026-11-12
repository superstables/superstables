# Superstables plugin

The Superstables plugin adds a skill and the connector at `https://mcp.superstables.com`. It helps an agent find services, read prices, request a single purchase and read a budget. The owner approves in their wallet. Testnet by default.

The [installation steps](https://github.com/superstables/superstables#the-plugin) cover Claude Code, Codex and Claude. The [install guide](https://github.com/superstables/superstables/blob/main/docs/install.md) covers the standalone skill and CLI.

In Claude Code and Codex, the plugin uses the CLI for actions that need the owner's machine and when the connector tools are unavailable. The CLI requires Node 22 or newer. In a chat app without a terminal, budget setup, grants, buying under a budget and `pay` need a coding agent on the owner's machine.
