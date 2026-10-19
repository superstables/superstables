// Preload for a test: mppx hands back a credential of another kind (a proof) where a signed transaction should be. It rewrites
// mppx's tempo charge client as it loads, so the check on the credential type in budget/tempo/buy.ts is the only guard.
import { register } from 'node:module'

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context)
  if (!url.endsWith('/mppx/dist/tempo/client/Charge.js')) return loaded
  const source = String(loaded.source)
  const patched = source.replace("payload: { signature, type: 'transaction' }", "payload: { signature, type: 'proof' }")
  if (patched === source) throw new Error('tempo-proof-credential: mppx changed; the preload no longer finds the credential to rewrite')
  return { ...loaded, source: patched }
}
`),
  import.meta.url,
)
