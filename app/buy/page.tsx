import type { Metadata } from "next";
import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { CopyBtn } from "@/components/app/ui";
import PriceChart from "@/components/token/PriceChart";
import TickerBar from "@/components/token/TickerBar";
import TokenDetails from "@/components/token/TokenDetails";
import VerifiedMark from "@/components/token/VerifiedMark";
import { tokenContract as staticTokenContract } from "@/content/site";
import { listings, token, uniswapSwapUrl } from "@/content/token";
import { getSetting, TOKEN_CONTRACT_KEY } from "@/lib/settings";
import "../app.css";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Buy $STBL",
  description: "Find the official STBL contract address on Robinhood Chain, links to third-party swap sites, and details of the STBL/NVDA pool fee.",
};

const ext = { target: "_blank", rel: "noopener noreferrer" } as const;

function WhereToBuy({ address, className }: { address: string; className: string }) {
  return (
    <div className={`buy-where ${className}`}>
      <h2>Where to buy</h2>
      <ListingGrid items={listings.buy} address={address} />
      <h2>Charts</h2>
      <ListingGrid items={listings.track} address={address} />
    </div>
  );
}

function ListingGrid({ items, address }: { items: typeof listings.buy; address: string }) {
  return (
    <div className="listing-grid">
      {items.map((l) => (
        <a key={l.name} className="listing" href={l.href(address)} {...ext}>
          {/* eslint-disable-next-line @next/next/no-img-element -- small local logos, no resizing needed */}
          <img src={l.logo} alt="" width={36} height={36} />
          <span><b>{l.name}</b><small>{l.note}</small></span>
        </a>
      ))}
    </div>
  );
}

export default async function BuyPage() {
  const address = (await getSetting(TOKEN_CONTRACT_KEY)) || staticTokenContract;
  return (
    <>
      <Nav current="/buy" />
      <main className="wrap" style={{ paddingTop: 56, paddingBottom: 96 }}>
        <div className="buy-hero">
          <div className="buy-copy">
            <div className="buy-head">
              <div>
                <span className="chain-badge">
                  {/* eslint-disable-next-line @next/next/no-img-element -- small local logo */}
                  <img src={token.chain.logo} alt="" width={20} height={20} />
                  On {token.chain.name}
                </span>
                <h1 style={{ fontSize: "clamp(36px, 5vw, 56px)", marginTop: 10 }}>Buy $STBL</h1>
              </div>
              {address && (
                <div className="buy-actions">
                  <a className="btn primary lg" href={uniswapSwapUrl(address)} {...ext}>Buy on Uniswap</a>
                  <CopyBtn text={address} className="btn lg" />
                </div>
              )}
            </div>
            {address && (
              <p className="buy-address" id="buy-contract">
                <VerifiedMark /><span>Contract</span> <code className="mono">{address}</code>
              </p>
            )}
            <PriceChart coinId={token.coingeckoId} />
            <p className="lede" style={{ marginTop: 12 }}>
              STBL trades on {token.chain.name} paired against a tokenized stock (NVDA).
            </p>
            <p className="warn-note">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                <path d="M12 9v4M12 17h.01" />
              </svg>
              <span>Before you confirm a swap, always check that the token address matches the one on this page to avoid fake listings.</span>
            </p>
            {address && <WhereToBuy address={address} className="narrow-only" />}

            <div className="sub-head" style={{ marginTop: 56 }}><h2>Contract details</h2></div>
            <TokenDetails address={address} />

            <div className="sub-head" style={{ marginTop: 36 }}><h2>How to buy</h2></div>
            <ol className="buy-steps">
              <li>To use the Uniswap link with ETH, have ETH on {token.chain.name} for the swap and gas. <a className="link" href={token.bridge} {...ext}>Open the bridge</a> if you need to move ETH to {token.chain.name}.</li>
              <li>Open Uniswap or another swap site listed above and connect your wallet there. Check the selected input token; some links select tokenized NVDA.</li>
              <li>Check the network and STBL contract address, then review the quoted amount and fees. Review each request in your wallet before approving or signing.</li>
            </ol>


            <div className="sub-head" style={{ marginTop: 36 }}><h2>How the fees work</h2></div>
            <p style={{ color: "var(--ink-2)" }}>
              Trades in the STBL/NVDA pool pay a 1% fee in tokenized NVDA to the project treasury. This fee applies to
              trades through that pool, including the portion of an ETH swap that Uniswap routes through it.
              The <Link className="link" href="/treasury">Treasury page</Link> shows fees and expenses recorded by the team.
            </p>

            <div className="sub-head" style={{ marginTop: 32 }}><h2>The dev wallet is locked</h2></div>
            <p style={{ color: "var(--ink-2)" }}>
              Tokens in the dev wallet are locked at launch. Unlocking them requires a governance vote on when and how the
              funds are deployed, and the funds can only be deployed into development and R&amp;D: the router, the index,
              and the audits they need. Lock and vote details will be published on this page.
            </p>

            <div className="sub-head" style={{ marginTop: 32 }}><h2>Why a token</h2></div>
            <p style={{ color: "var(--ink-2)" }}>
              The router is in development. We plan to release it as open-source software, with signing handled
              locally. STBL/NVDA pool fees contribute to the project treasury.
            </p>

            <p style={{ marginTop: 28, fontSize: 14, color: "var(--ink-2)" }}>
              Nothing on this page is financial advice. Questions:{" "}
              <a className="link" href="https://x.com/superstables" {...ext}>@superstables</a>.
            </p>
          </div>
          {address && (
            <aside className="buy-aside">
              <TickerBar address={address} />
              <WhereToBuy address={address} className="wide-only" />
            </aside>
          )}
        </div>

      </main>
      <Footer />
    </>
  );
}
