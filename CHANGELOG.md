# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-18

The first tagged version of the Superstables site: the service index, its API and
read-only MCP server, and, new in this version, a paid demo service that agents can pay on
the Base Sepolia testnet.

### Added

- `/api/demo/market`: a paid x402 endpoint serving spot price and 24h change for BTC or ETH.
  It validates the request before demanding payment, answers 402 with its terms in the
  `PAYMENT-REQUIRED` header and body, checks the buyer's credential against those terms, and
  has a public Base Sepolia facilitator verify and settle the transfer before answering 200
  with a `PAYMENT-RESPONSE` receipt. Test USDC on Base Sepolia only: no real money moves.
- `/api/demo`: free, machine-readable self-description of that service — endpoint, parameters,
  price, network, asset and the address that is paid.
- Configuration: `SUPERSTABLES_DEMO_PAY_TO` (required; the endpoint answers 503 until it is
  set) and `SUPERSTABLES_DEMO_PRICE` (optional, decimal USDC per call, default `0.01`).
