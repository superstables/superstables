# hosted-budget-setup / claude-sonnet (sonnet) / without skill

## Query

Set up a 1 USDC budget on Base Sepolia that I can approve from my phone.

## Transcript

AGENT: I'll start by checking what's in the working directory and whether any wallet or budget tooling is already set up.

TOOL Bash: ls -la; env | grep -i -E 'wallet|base|usdc|cdp|rpc' | sed 's/=.*/=<set>/'; which cast node python3 npx 2>/dev/null

OUTPUT:
Exit code 1
total 8
drwxrwxr-x 2 alladin alladin 4096 Oct 18 15:09 .
drwxrwxr-x 7 alladin alladin 4096 Oct 18 15:09 ..
/usr/bin/node
/usr/bin/python3
/usr/bin/npx

AGENT: I haven't set anything up yet. The working directory is empty, and I found no wallet, RPC, or USDC tooling in the environment. "Budget" could also mean a few different things, and the choice changes the design.

Here are the options I see:

1. **Spend-permission or allowance contract.** Your wallet approves a 1 USDC cap for an agent address, using an ERC-20 `approve` or a spend-permission or session-key contract. Your phone wallet, such as MetaMask Mobile or Coinbase Wallet, signs it. The agent can only spend up to 1 USDC.
2. **Multisig (Safe) with a 1 USDC limit.** The agent proposes transactions, and you approve each one from the Safe mobile app.
3. **x402 or payment-gated flow.** The agent pays per request from a capped wallet, and you approve top-ups.

Whichever you pick, these details decide the setup:
- Which wallet do you use on your phone?
- Should the agent hold its own key (a fresh, throwaway Base Sepolia key I generate locally), or should it only propose transactions?
- Do you want the cap enforced on-chain, or is a soft limit in a script enough?

Base Sepolia USDC is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. You can get test USDC from Circle's faucet at faucet.circle.com, and it has no real value.

I'd suggest option 1 with a fresh agent key. I'd generate the key locally, write a small script that builds the `approve(agent, 1_000_000)` transaction (USDC has 6 decimals), and show it as a WalletConnect or QR request for you to sign on your phone. Tell me which wallet you use and that you want this option, and I'll build it. I won't send any transactions without your go-ahead.

FINAL (success, 2 turns): I haven't set anything up yet. The working directory is empty, and I found no wallet, RPC, or USDC tooling in the environment. "Budget" could also mean a few different things, and the choice changes the design.

Here are the options I see:

1. **Spend-permission or allowance contract.** Your wallet approves a 1 USDC cap for an agent address, using an ERC-20 `approve` or a spend-permission or session-key contract. Your phone wallet, such as MetaMask Mobile or Coinbase Wallet, signs it. The agent can only spend up to 1 USDC.
2. **Multisig (Safe) with a 1 USDC limit.** The agent proposes transactions, and you approve each one from the Safe mobile app.
3. **x402 or payment-gated flow.** The agent pays per request from a capped wallet, and you approve top-ups.

Whichever you pick, these details decide the setup:
- Which wallet do you use on your phone?
- Should the agent hold its own key (a fresh, throwaway Base Sepolia key I generate locally), or should it only propose transactions?
- Do you want the cap enforced on-chain, or is a soft limit in a script enough?

Base Sepolia USDC is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. You can get test USDC from Circle's faucet at faucet.circle.com, and it has no real value.

I'd suggest option 1 with a fresh agent key. I'd generate the key locally, write a small script that builds the `approve(agent, 1_000_000)` transaction (USDC has 6 decimals), and show it as a WalletConnect or QR request for you to sign on your phone. Tell me which wallet you use and that you want this option, and I'll build it. I won't send any transactions without your go-ahead.
