// Strict command-line parsing shared by every Tempo script (contract rule 6).
//
// Plain JavaScript on purpose: the .ts scripts, the .mjs helpers in tempo-wallet/ and wallet/ all
// import it, and it must run before anything else (before any env or key file is read, before any
// RPC write). `--help` / `-h` prints usage and exits 0. An unknown flag, a stray argument, a missing
// required flag, a flag that needs a value but has none, or a value that fails its own check exits 2.
//
// Usage:
//   const { values, positionals } = parseCli({
//     name: 'buy.ts',
//     summary: 'Pay one MPP seller from the owner budget.',
//     flags: {
//       url: { type: 'string', required: true, desc: 'Seller URL' },
//       wallet: { type: 'boolean', desc: 'Use the MetaMask-owned budget' },
//     },
//     positionals: { names: [], min: 0, max: 0 },   // optional, default: none allowed
//     examples: ['npx tsx budget/tempo/buy.ts --url https://mpp.dev/api/ping/paid --max 0.2'],
//   })

/**
 * @typedef {{ type: 'string' | 'boolean', required?: boolean, desc?: string, choices?: string[],
 *   check?: (v: string) => string | undefined, metavar?: string }} FlagSpec
 * @typedef {{ name: string, summary?: string, flags?: Record<string, FlagSpec>,
 *   positionals?: { names?: string[], min?: number, max?: number }, examples?: string[], notes?: string[] }} CliSpec
 */

/** @param {CliSpec} spec */
export function usageText(spec) {
  const flags = spec.flags ?? {}
  const pos = spec.positionals ?? {}
  const posNames = pos.names ?? []
  const lines = []
  const flagSyntax = Object.entries(flags).map(([n, f]) => {
    const body = f.type === 'boolean' ? `--${n}` : `--${n} <${f.metavar ?? 'value'}>`
    return f.required ? body : `[${body}]`
  })
  lines.push(`Usage: ${spec.name} ${[...posNames.map((p, i) => ((pos.min ?? 0) > i ? `<${p}>` : `[${p}]`)), ...flagSyntax].join(' ')}`)
  if (spec.summary) lines.push('', spec.summary)
  if (Object.keys(flags).length) {
    lines.push('', 'Flags:')
    for (const [n, f] of Object.entries(flags)) {
      const head = f.type === 'boolean' ? `--${n}` : `--${n} <${f.metavar ?? 'value'}>`
      const tags = [f.required ? 'required' : null, f.choices ? `one of ${f.choices.join('|')}` : null].filter(Boolean).join(', ')
      lines.push(`  ${head.padEnd(28)} ${f.desc ?? ''}${tags ? ` (${tags})` : ''}`)
    }
  }
  lines.push(`  ${'-h, --help'.padEnd(28)} Print this text and exit 0`)
  if (spec.notes?.length) lines.push('', ...spec.notes)
  if (spec.examples?.length) lines.push('', 'Examples:', ...spec.examples.map((e) => `  ${e}`))
  lines.push('', 'Exit codes: 0 ok, 2 bad usage (nothing was read or sent).')
  return lines.join('\n')
}

function bad(spec, message) {
  process.stderr.write(`${spec.name}: ${message}\n\n${usageText(spec)}\n`)
  process.exit(2)
}

/**
 * @param {CliSpec} spec
 * @param {string[]} [argv]
 * @returns {{ values: Record<string, string | boolean | undefined>, positionals: string[] }}
 */
export function parseCli(spec, argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usageText(spec) + '\n')
    process.exit(0)
  }
  const flags = spec.flags ?? {}
  const values = {}
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg)
      continue
    }
    if (!arg.startsWith('--')) bad(spec, `unknown option ${arg}`)
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    const spec1 = Object.hasOwn(flags, name) ? flags[name] : undefined
    if (!spec1) bad(spec, `unknown flag --${name}`)
    if (Object.hasOwn(values, name)) bad(spec, `flag --${name} given twice`)
    if (spec1.type === 'boolean') {
      if (eq !== -1) bad(spec, `flag --${name} takes no value`)
      values[name] = true
      continue
    }
    let value
    if (eq !== -1) value = arg.slice(eq + 1)
    else {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) bad(spec, `flag --${name} needs a value`)
      value = next
      i++
    }
    if (value === '') bad(spec, `flag --${name} needs a non-empty value`)
    if (spec1.choices && !spec1.choices.includes(value)) bad(spec, `flag --${name} must be one of ${spec1.choices.join('|')}`)
    if (spec1.check) {
      const problem = spec1.check(value)
      if (problem) bad(spec, `flag --${name}: ${problem}`)
    }
    values[name] = value
  }
  for (const [name, f] of Object.entries(flags)) {
    if (f.required && values[name] === undefined) bad(spec, `missing required flag --${name}`)
  }
  const pos = spec.positionals ?? {}
  const min = pos.min ?? 0
  const max = pos.max ?? 0
  if (positionals.length < min) bad(spec, `missing argument${(pos.names ?? [])[positionals.length] ? ` <${pos.names[positionals.length]}>` : ''}`)
  if (positionals.length > max) bad(spec, `unexpected argument ${JSON.stringify(positionals[max])}`)
  return { values, positionals }
}

// ---- small validators, usable as `check` -----------------------------------------------------

/** A positive decimal with at most `decimals` fractional digits (no sign, no exponent). */
export const decimalCheck = (decimals = 6) => (v) => {
  if (!/^\d+(\.\d+)?$/.test(v)) return `${JSON.stringify(v)} is not a plain decimal number`
  const frac = v.split('.')[1] ?? ''
  if (frac.length > decimals) return `${JSON.stringify(v)} has more than ${decimals} decimal places`
  if (!/[1-9]/.test(v)) return 'must be greater than 0'
  return undefined
}

export const intCheck = (min = 1) => (v) => (/^\d+$/.test(v) && Number(v) >= min ? undefined : `must be an integer >= ${min}`)

export const addressCheck = (v) => (/^0x[0-9a-fA-F]{40}$/.test(v) ? undefined : 'must be a 0x address (40 hex characters)')

export const addressListCheck = (v) => {
  for (const a of v.split(',')) if (!/^0x[0-9a-fA-F]{40}$/.test(a.trim())) return `${JSON.stringify(a)} is not a 0x address`
  return undefined
}

export const opIdCheck = (v) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) ? undefined : 'operation id must be 1-64 characters: letters, digits, dot, dash, underscore')

/**
 * An agent key's label (--agent LABEL, the AGENT<label>_ lines): the one syntax the dispatcher, every tempo script and the
 * hosted signer accept, so a label setup takes works in every command.
 */
export const LABEL = '[A-Za-z0-9_]{1,40}'
export const LABEL_WORDS = '1 to 40 letters, digits or underscores'
export const labelCheck = (v) => (new RegExp(`^${LABEL}$`).test(v) ? undefined : `label must be ${LABEL_WORDS}`)

export const urlCheck = (v) => {
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:' ? undefined : 'must be an http(s) URL'
  } catch {
    return 'not a valid URL'
  }
}

export const hashCheck = (v) => (/^0x[0-9a-fA-F]{64}$/.test(v) ? undefined : 'must be a 0x transaction hash (64 hex characters)')
