// siteCall (tempo): one request to the site, signed with the Tempo agent key, for the dispatcher. It opens the agent key file only,
// signs only the site request (never a payment), and prints what the site answered as one RESULT line. The dispatcher decides what
// the answer means; nothing here pays, pulls or sends a transaction.
// npx tsx budget/tempo/siteCall.ts --site <origin> --path /api/v1/budget/purchases --body <json> [--agent <label>] [--timeout-ms <n>]
//   npx tsx budget/tempo/siteCall.ts --site <origin> --method GET --path /api/v1/budget/services
import { labelCheck, parseCli } from './lib/args.mjs'
import { loadAgentEnv, resolveAgentKeys } from './lib/common.ts'
import { signedSitePost, siteCallArgs } from '../site-request.ts'

const { values: args } = parseCli({
  name: 'siteCall.ts',
  summary: 'Send one request to the site, signed with the agent key (never a payment), and print the answer as one RESULT line.',
  flags: {
    site: { type: 'string', required: true, metavar: 'origin', desc: 'The site the budget is linked to' },
    path: { type: 'string', required: true, metavar: 'route', desc: 'A route the agent key signs: see budget/site-request.ts' },
    method: { type: 'string', metavar: 'GET|POST', desc: 'Default POST', choices: ['GET', 'POST'] },
    body: { type: 'string', metavar: 'json', desc: 'The JSON body of a POST' },
    'timeout-ms': { type: 'string', metavar: 'n', desc: 'Give up on the site after n milliseconds (1 to 15000, default 15000)' },
    agent: { type: 'string', metavar: 'label', desc: 'Agent label; omit for the primary agent', check: labelCheck },
  },
  examples: ['npx tsx budget/tempo/siteCall.ts --site https://www.superstables.com --method GET --path /api/v1/budget/services'],
})

const call = siteCallArgs((n) => (typeof args[n] === 'string' ? (args[n] as string) : undefined))
if (!call) {
  console.log(`RESULT ${JSON.stringify({ ok: false, command: 'siteCall', rail: 'tempo', state: 'refused_precheck', reason: 'needs --site, --path and a JSON --body for a POST, and --timeout-ms is 1 to 15000', next: 'nothing was signed or sent' })}`)
  process.exit(3)
}
const { privateKey } = resolveAgentKeys(loadAgentEnv(), typeof args.agent === 'string' ? args.agent : '')
const reply = await signedSitePost(privateKey, call!.site, call!.path, call!.body, call!.method, { timeoutMs: call!.timeoutMs })
console.log(`RESULT ${JSON.stringify({ ok: true, command: 'siteCall', rail: 'tempo', chain: 'moderato', state: 'ok', reply })}`)
process.exit(0)
