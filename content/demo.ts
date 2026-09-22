/**
 * Copy and data for the /demo landing page. Everything the page says lives here so the
 * components stay structural; the markdown twin at /demo.md renders the same content.
 *
 * Written against the public client v0.1.0 release. The setup commands and configuration
 * snippets are displayed for the reader to copy; the site never runs them.
 */

const CLIENT_REPO = "https://github.com/superstables/superstables-client";
const CLIENT_TAG = "v0.1.0";
const CLIENT_BUNDLE = "superstables-0.1.0.mcpb";

export const demoPage = {
  title: "Try the Superstables demo | Agent payments with your approval",
  description:
    "Watch an AI agent find a paid service, request your approval in MetaMask, and return a result with a payment receipt. Try the Base Sepolia testnet demo.",

  hero: {
    headingLine1: "Your agent finds it.",
    headingLine2: "You approve it.",
    lede: "Find a paid service, review its price, and approve the payment in MetaMask. See the result and the receipt, from one conversation.",
    primary: "Watch the demo",
    secondary: "Try it yourself",
  },

  video: {
    src: "/demo/superstables-demo-voiceover-EN.mp4",
    poster: "/demo/approval-poster-EN.jpg",
    type: "video/mp4",
    width: 1934,
    height: 1080,
    /** Seconds; the recording has a voiceover audio track. */
    durationSeconds: 30.433333,
    label: "Superstables demo: quote, MetaMask approval, result and receipt",
    disclosure: "Read the video description",
    description:
      "A voiceover narrates each step. In Claude Desktop, a user asks for a paid BTC price service and reviews a quote. The user opens the payment request, checks 0.01 test USDC on Base Sepolia, and confirms the signature in MetaMask. Back in the conversation, Claude displays the BTC result and a receipt link. The recording ends on the Base Sepolia explorer showing a successful transaction and a 0.01 USDC transfer. The amount and market data belong to this recorded example.",
    unavailable: "Video unavailable. Read the description below, or",
    openFile: "open the video file",
    unsupported: "Your browser cannot play this recording.",
  },

  flow: [
    { title: "Find and quote", body: "Ask for a service. Your agent checks what it can call and shows you the payment terms." },
    { title: "Review and approve", body: "Check the amount, asset, network and recipient. Sign in MetaMask when you are ready." },
    { title: "See what happened", body: "On a successful call, get the service's answer and inspect the payment receipt." },
  ],

  harness: {
    heading: "Use our MCP with your favorite harness",
    intro: "Superstables connects to apps that support local MCP servers over stdio. Choose yours for setup instructions.",
    legend: "Choose your app",
    note: "Claude Desktop is the guided flow shown in this demo. These apps document MCP support. The demo services switch in each snippet adds Superstables' prepared demo services, whose answers are simulated, to what your agent can find; leave it out to see only real sellers.",
    /** Read aloud by the polite live region after a choice. */
    announce: (appName: string) => `Showing setup instructions for ${appName}.`,
  },

  setup: {
    headingLine1: "Make your first",
    headingLine2: "test payment.",
    intro: "You will need MetaMask and test USDC on Base Sepolia. Every app except Claude Desktop also needs Node.js 20+ to run the client. The wallet setup and first request are the same whichever app you choose.",
    guideLabel: "Superstables setup guide",
    guideUrl: `${CLIENT_REPO}/blob/${CLIENT_TAG}/docs/install.md`,
    releaseLabel: "View release & download",
    releaseUrl: `${CLIENT_REPO}/releases/tag/${CLIENT_TAG}`,
    build: {
      summary: "First, install the local client (not needed for Claude Desktop)",
      intro: "Claude Desktop users can skip this: the extension already contains the built client. For the other apps, with Git and Node.js 20+ installed, run these commands once. If you already have this release built and configured, use its folder.",
      code: `git clone --branch ${CLIENT_TAG} ${CLIENT_REPO}.git\ncd superstables-client\nnpm install\nnpm run build\nnpx superstables setup`,
      label: "Install Superstables client",
      after:
        "Use the full path to this folder in your app's configuration. On Windows, JSON paths can use forward slashes, for example C:/Users/you/superstables-client/dist/mcp/main.js. If the app cannot find Node, use the full path to the Node executable too.",
    },
    wallet: {
      title: "Prepare MetaMask",
      before: "Use a test account with test USDC on Base Sepolia. Follow the ",
      linkLabel: "wallet setup guide",
      after: " for the network and faucet steps.",
    },
    quote: {
      title: "Ask for a quote",
      before: "Start a new conversation in ",
      after: " with Superstables enabled. Try this:",
      prompt: "Find a paid BTC market-data service on Base Sepolia that you can call. Show me its price before I approve any payment.",
      copy: "Copy prompt",
      copied: "Copied",
      copiedStatus: "Prompt copied.",
      copyFailed: "Select and copy the prompt above.",
    },
    help: {
      next: "When the payment request opens, review its terms and sign in MetaMask to continue.",
      developer: "Using the CLI or TypeScript?",
      developerLink: "Read the developer setup.",
      stuck: "Stuck during setup?",
      stuckLink: "Share what happened.",
    },
  },

  questions: {
    heading: "A few useful details.",
    items: [
      { q: "Does this use real money?", a: "The demo uses test USDC on Base Sepolia. It does not support mainnet payments." },
      { q: "Can the agent pay without asking me?", a: "No. This release requires your approval for every payment. In the default flow, your signing key stays in MetaMask." },
      { q: "Can I pay every service in the directory?", a: "No. Start with the supported demo services. Other directory listings can appear in search without being callable by this release." },
      { q: "What happens if a payment is interrupted?", a: "Check its status before trying again. A payment can be marked uncertain, and the client does not retry it automatically. The payment outcome and the service response are recorded separately." },
    ],
  },

  feedback: {
    heading: "Help shape the next release.",
    body: "Tell us what worked, what got in the way, or where you stopped. Setup feedback is useful too.",
    cta: "Share demo feedback",
    href: "/demo-feedback",
  },
} as const;

/** The apps a reader can pick; ids are the radio values. */
export type DemoAppId = "claude-desktop" | "codex" | "claude-code" | "cursor" | "vscode";

export type DemoApp = {
  id: DemoAppId;
  name: string;
  /** Step 1 heading for this app. */
  title: string;
  intro: string;
  /** Configuration or command to show, or null when the app installs a bundle instead. */
  code: string | null;
  /** Language hint for the snippet, used only in the markdown twin. */
  codeLang: "toml" | "sh" | "json" | null;
  after: string;
  /** The app vendor's own MCP setup documentation. */
  url: string;
};

export const DEFAULT_APP: DemoAppId = "claude-desktop";

export const demoApps: readonly DemoApp[] = [
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    title: "Install the Claude Desktop extension",
    intro: `Download ${CLIENT_BUNDLE} from the release page. It contains the built client, so there is nothing to clone or compile. In Claude Desktop, go to Settings → Extensions → Advanced → Install Extension and choose the file.`,
    code: null,
    codeLang: null,
    after: "Enable Superstables in a new conversation. This is the path shown in the demo.",
    url: "https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop",
  },
  {
    id: "codex",
    name: "Codex",
    title: "Connect Superstables to Codex",
    intro: "After building the client below, add this server to ~/.codex/config.toml. Keep any existing settings and replace the example path with your client folder.",
    code: '[mcp_servers.superstables]\ncommand = "node"\nargs = ["/absolute/path/superstables-client/dist/mcp/main.js"]\nenv = { SUPERSTABLES_DEMO_SERVICES = "on" }',
    codeLang: "toml",
    after: "Restart your local Codex session and check that Superstables appears in the MCP server list.",
    url: "https://learn.chatgpt.com/docs/extend/mcp",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    title: "Connect Superstables to Claude Code",
    intro: "After building the client below, run this command from the project where you want to use Superstables. Replace the example path with your client folder.",
    code: 'claude mcp add --transport stdio -e SUPERSTABLES_DEMO_SERVICES=on superstables -- node "/absolute/path/superstables-client/dist/mcp/main.js"',
    codeLang: "sh",
    after: "Open Claude Code in that project and run /mcp to check the connection.",
    url: "https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server",
  },
  {
    id: "cursor",
    name: "Cursor",
    title: "Connect Superstables to Cursor",
    intro: "After building the client below, add this entry to .cursor/mcp.json in your project. Keep any existing servers and replace the example path with your client folder.",
    code: '{\n  "mcpServers": {\n    "superstables": {\n      "type": "stdio",\n      "command": "node",\n      "args": [\n        "/absolute/path/superstables-client/dist/mcp/main.js"\n      ],\n      "env": { "SUPERSTABLES_DEMO_SERVICES": "on" }\n    }\n  }\n}',
    codeLang: "json",
    after: "Save the file, then enable Superstables in Cursor’s MCP settings. Use a local Agent conversation.",
    url: "https://cursor.com/docs/mcp#stdio-server-configuration",
  },
  {
    id: "vscode",
    name: "VS Code with GitHub Copilot",
    title: "Connect Superstables to VS Code",
    intro: "After building the client below, add this entry to .vscode/mcp.json in your local workspace. Keep any existing servers and replace the example path with your client folder.",
    code: '{\n  "servers": {\n    "superstables": {\n      "type": "stdio",\n      "command": "node",\n      "args": [\n        "/absolute/path/superstables-client/dist/mcp/main.js"\n      ],\n      "env": { "SUPERSTABLES_DEMO_SERVICES": "on" }\n    }\n  }\n}',
    codeLang: "json",
    after: "Save the file, start the server from the MCP controls, and enable its tools in GitHub Copilot’s Agent chat.",
    url: "https://code.visualstudio.com/docs/agent-customization/mcp-servers",
  },
];
