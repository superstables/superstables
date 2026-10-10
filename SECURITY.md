# Security policy

## Reporting a vulnerability

Report it privately, in one of two ways:

- [open a private report](https://github.com/superstables/superstables/security/advisories/new)
  on GitHub;
- or email **s@superstables.com**.

Please don't open a public issue, pull request or discussion for a security problem.

Include what you can of the following:

- the version or commit you tested;
- the wallet mode and chain involved;
- the steps to reproduce, and what happened compared with what you expected;
- the impact as you see it, for example a payment the owner did not approve, a spend above a
  Budget's limit, or a secret written where it should not be.

We'll confirm we received the report, keep you informed while we work on it, and agree a
disclosure date with you before we publish anything. Tell us if you'd like to be credited.

## Supported versions

Fixes go into the next release. We don't backport them to earlier versions, so please test
against the latest release or `main`.

## Scope

This policy covers the code in this repository: the CLI, the agent skill, the local approval
pages and the Budget scripts. The client runs on testnets only and moves test tokens.

[The security boundary](docs/security.md) describes what the design protects and what it does
not. A report that shows the client breaking one of the guarantees on that page is in scope,
including through a seller's payment challenge, an approval request on localhost or a recovery
after an uncertain outcome.
