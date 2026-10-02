import Link from "next/link";
import CopyValue from "@/components/CopyValue";
import { explorerTokenUrl, token, uniswapPoolUrl } from "@/content/token";
import AddToWallet from "./AddToWallet";
import VerifiedMark from "./VerifiedMark";

const ext = { target: "_blank", rel: "noopener noreferrer" } as const;

/**
 * Contract details for STBL, shared by /buy and /treasury. `address` is null until it is published.
 * On /treasury (`onTreasury`) the panel offers Buy $STBL instead of linking back to the Treasury page.
 */
export default function TokenDetails({ address, onTreasury = false }: { address: string | null; onTreasury?: boolean }) {
  return (
    <div className="panel">
      <div className="settings-row">
        <span>
          <b>Contract address</b>
          {address ? (
            <p><CopyValue value={address} label="Copy contract address" before={<VerifiedMark />} /></p>
          ) : (
            <p>Contract address unavailable.</p>
          )}
        </span>
      </div>
      <div className="settings-row">
        <span>
          <b>Chain</b>
          <p className="chain-line">
            {/* eslint-disable-next-line @next/next/no-img-element -- small local logo */}
            <img src={token.chain.logo} alt="" width={16} height={16} />
            {token.chain.name} · chain ID {token.chain.id}
          </p>
        </span>
      </div>
      <div className="settings-row">
        <span><b>Token</b><p>{token.name} ({token.symbol}) · {token.decimals} decimals · {token.totalSupply} total supply</p></span>
      </div>
      <div className="settings-row">
        <span><b>Main pool</b><p>{token.mainPool.pair} on {token.mainPool.dex}</p></span>
        <a className="btn sm" href={uniswapPoolUrl} {...ext}>View pool</a>
      </div>
      <div className="settings-row">
        <span>
          <b>Trading fee</b>
          <p>Trades in the STBL/NVDA pool pay a 1% fee in tokenized NVDA to the project treasury.{!onTreasury && <> See the <Link className="link" href="/treasury">Treasury page</Link> for recorded fees and expenses.</>}</p>
        </span>
      </div>
      {address && (
        <div className="settings-row">
          <span><b>Explorer</b><p><a className="link" href={explorerTokenUrl(address)} {...ext}>View STBL on the Robinhood Chain explorer</a></p></span>
          {onTreasury && <Link className="btn sm primary" href="/buy">Buy $STBL</Link>}
        </div>
      )}
      {address && (
        <div className="settings-row">
          <span>
            <b>Add to wallet</b>
            <p>This asks your browser wallet to display STBL. Your wallet may also prompt you to switch to or add {token.chain.name}. No signature or transaction is requested.</p>
          </span>
          <AddToWallet address={address} />
        </div>
      )}
    </div>
  );
}
