/**
 * Detects transfer-tax (and, as a bonus, rebasing) tokens before they are
 * added to a tokenlist.
 *
 * How the tax check works
 * ----------------------
 * A tax can only be measured by actually moving tokens, but we hold none and
 * must not broadcast anything. So we simulate: `eth_call` accepts a state
 * override that replaces the *code* at any address, and we point it at a real
 * holder found via Blockscout. Because TaxProbe's code then lives at the
 * holder's address, `msg.sender` inside the token's `transfer()` is that
 * holder and the balance is genuine - no minting, no storage-slot guessing.
 *
 * The probe reads balances and totalSupply either side of the transfer, and we
 * compare what left the sender against what reached the recipient. Any
 * shortfall is the tax.
 *
 * Because fee exemptions are common (owner, router and pair are usually
 * exempt), a single holder proves little, so several are sampled and the worst
 * result wins. Transfers toward and away from the largest contract holder -
 * almost always the LP pair - approximate the sell and buy directions, which
 * is where fee-on-transfer tokens usually hide their tax.
 *
 * Example usage:
 *   npm run token:check-tax                     # every Robinhood token
 *   npm run token:check-tax -- --manual         # just tokens/manual.ts
 *   npm run token:check-tax -- 0xabc... 0xdef...
 *   npm run token:check-tax -- --json report.json
 *   npm run token:check-tax -- --write     # drop failing tokens from the lists
 *
 * Exits non-zero if any token is judged TAXED or REBASING, so CI can gate on
 * it.
 */

import chalk from 'chalk'
import fs from 'fs'
import path from 'path'
import { AbiCoder, getAddress, id, isAddress } from 'ethers'
import configs from '../../config'
import { Network } from '../../types'
import { sleep } from '../utils'
import {
  TAX_PROBE_RETURNS,
  TAX_PROBE_RUNTIME,
  TAX_PROBE_SELECTOR,
} from './lib/tax-probe'

const NETWORK = Network.Robinhood

// A local archive node answers far faster than the public endpoint and skips
// its Cloudflare challenge, so prefer one when the operator points us at it.
const RPC_URL =
  process.env.ROBINHOOD_RPC_URL || (configs[NETWORK].rpc as string)
const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com/api/v2'

/**
 * The two files that feed tokens.ts. `--write` removes failing addresses from
 * both, so nothing that measures taxed reaches the generated tokenlist.
 */
const TOKEN_FILES = [
  path.resolve(__dirname, '../../tokenlists/robinhood/tokens/manual.ts'),
  path.resolve(__dirname, '../../tokenlists/robinhood/tokens/robinhood.ts'),
]

// prettier ships no type declarations on v2, so require it with a local shape.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const prettier = require('prettier') as {
  format(source: string, options: Record<string, unknown>): string
  resolveConfig: { sync(filepath: string): Record<string, unknown> | null }
}

// The RPC and the explorer both sit behind Cloudflare, which serves a JS
// challenge to clients that do not look like browsers.
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36'

/** Burn-style address used as the transfer recipient; holds no code. */
const SINK = '0x000000000000000000000000000000000000bEEF'

/** Ignore sub-0.1% shortfalls, which are integer-division dust, not a tax. */
const TAX_TOLERANCE_BPS = 10

/** How many distinct EOA holders to sample before giving up on a token. */
const HOLDER_SAMPLE_SIZE = 3

const GAS_LIMIT = '0x2faf080' // 50M, plenty for the probe's six subcalls

const coder = AbiCoder.defaultAbiCoder()

/**
 * Public getters that fee-on-transfer and rebasing tokens tend to expose.
 * Solidity emits each selector as a PUSH4 in the dispatcher, so finding one in
 * the runtime bytecode is good evidence the machinery exists - even when every
 * holder we sampled happened to be fee-exempt.
 */
const TAX_SIGNATURES = [
  'buyTax()',
  'sellTax()',
  'transferTax()',
  'totalFees()',
  'marketingFee()',
  'liquidityFee()',
  'swapTokensAtAmount()',
  'isExcludedFromFees(address)',
  '_isExcludedFromFee(address)',
  'setFees(uint256,uint256)',
  'reflectionFromToken(uint256,bool)',
  'tokenFromReflection(uint256)',
]

const REBASE_SIGNATURES = [
  'rebase()',
  'sharesOf(address)',
  'totalShares()',
  'rebaseIndex()',
  'scaledBalanceOf(address)',
  'getSharesByPooledEth(uint256)',
  'gonsForBalance(uint256)',
]

type Verdict = 'CLEAN' | 'TAXED' | 'REBASING' | 'SUSPICIOUS' | 'UNKNOWN'

interface ProbeResult {
  label: string
  ok: boolean
  amount: bigint
  sent: bigint
  received: bigint
  supplyDelta: bigint
  taxBps: number
}

interface TokenReport {
  address: string
  symbol?: string
  verdict: Verdict
  maxTaxBps: number
  burnsOnTransfer: boolean
  taxHints: string[]
  rebaseHints: string[]
  probes: ProbeResult[]
  notes: string[]
}

interface Holder {
  address: string
  isContract: boolean
  value: bigint
}

/**
 * Wraps fetch with a retry for Cloudflare's interstitial, which arrives as an
 * HTML body with a 200 status rather than an error code.
 */
async function fetchJson(
  url: string,
  init: RequestInit = {},
  tries = 6
): Promise<any> {
  let lastError = 'unknown error'

  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          ...(init.headers ?? {}),
        },
      })

      const text = await response.text()

      // Cloudflare challenge rather than a JSON-RPC reply.
      if (text.trimStart().startsWith('<')) {
        lastError = 'blocked by Cloudflare challenge'
        await sleep(700 * (attempt + 1))
        continue
      }

      return JSON.parse(text)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await sleep(700 * (attempt + 1))
    }
  }

  throw new Error(`Request to ${url} failed: ${lastError}`)
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  const body = await fetchJson(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })

  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

async function getCode(token: string): Promise<string> {
  return (await rpc('eth_getCode', [token, 'latest'])) ?? '0x'
}

/** Blockscout returns holders largest-first, with an is_contract flag. */
async function getHolders(token: string): Promise<Holder[]> {
  try {
    const body = await fetchJson(`${BLOCKSCOUT}/tokens/${token}/holders`)
    if (!Array.isArray(body?.items)) return []

    return body.items
      .filter((item: any) => isAddress(item?.address?.hash))
      .map((item: any) => ({
        address: getAddress(item.address.hash),
        isContract: Boolean(item.address.is_contract),
        value: BigInt(item.value ?? '0'),
      }))
      .filter((holder: Holder) => holder.value > 0n)
  } catch (error) {
    return []
  }
}

/** Scans runtime bytecode for the 4-byte selectors of the given signatures. */
function findSelectors(code: string, signatures: string[]): string[] {
  const bytecode = code.toLowerCase()
  return signatures.filter((signature) =>
    bytecode.includes(id(signature).slice(2, 10))
  )
}

/**
 * Simulates `from` sending `amount` of `token` to `to`, by installing the
 * probe at `from`. Returns raw readings; all arithmetic is done here in BigInt
 * so a reflection token that *grows* a balance cannot underflow on-chain.
 */
async function runProbe(
  label: string,
  token: string,
  from: string,
  to: string,
  amount: bigint
): Promise<ProbeResult> {
  const data =
    TAX_PROBE_SELECTOR +
    coder
      .encode(['address', 'address', 'uint256'], [token, to, amount])
      .slice(2)

  const raw = await rpc('eth_call', [
    { to: from, data, gas: GAS_LIMIT },
    'latest',
    { [from]: { code: TAX_PROBE_RUNTIME } },
  ])

  const [
    ok,
    fromBefore,
    fromAfter,
    toBefore,
    toAfter,
    supplyBefore,
    supplyAfter,
  ] = coder.decode(TAX_PROBE_RETURNS, raw)

  const sent = BigInt(fromBefore) - BigInt(fromAfter)
  const received = BigInt(toAfter) - BigInt(toBefore)
  const supplyDelta = BigInt(supplyAfter) - BigInt(supplyBefore)

  // Tax is what the recipient failed to receive out of the requested amount.
  // Clamped at zero so a reflection credit reads as 0, not a negative tax.
  const shortfall = amount > received ? amount - received : 0n
  const taxBps = amount > 0n ? Number((shortfall * 10000n) / amount) : 0

  return {
    label,
    ok: Boolean(ok),
    amount,
    sent,
    received,
    supplyDelta,
    taxBps,
  }
}

/**
 * Picks the transfer amount. 1% of the holder's balance keeps us clear of
 * max-transaction limits, which many fee-on-transfer tokens enforce and which
 * would otherwise revert the probe and look like a clean result.
 */
function probeAmount(holder: Holder): bigint {
  const onePercent = holder.value / 100n
  return onePercent > 0n ? onePercent : holder.value
}

async function checkToken(
  address: string,
  symbol?: string
): Promise<TokenReport> {
  const report: TokenReport = {
    address,
    symbol,
    verdict: 'UNKNOWN',
    maxTaxBps: 0,
    burnsOnTransfer: false,
    taxHints: [],
    rebaseHints: [],
    probes: [],
    notes: [],
  }

  const code = await getCode(address)
  if (!code || code === '0x') {
    report.notes.push('no contract code at this address')
    return report
  }

  report.taxHints = findSelectors(code, TAX_SIGNATURES)
  report.rebaseHints = findSelectors(code, REBASE_SIGNATURES)

  const holders = await getHolders(address)
  if (!holders.length) {
    report.notes.push('Blockscout returned no holders; could not simulate')
    return finalise(report)
  }

  const eoas = holders.filter((holder) => !holder.isContract)
  const pair = holders.find((holder) => holder.isContract)

  // Plain wallet-to-wallet transfers from several holders, since any single
  // one may be on the fee exemption list.
  for (const holder of eoas.slice(0, HOLDER_SAMPLE_SIZE)) {
    await pushProbe(
      report,
      `EOA ${short(holder.address)} -> sink`,
      address,
      holder.address,
      SINK,
      probeAmount(holder)
    )
  }

  // Toward the pair approximates a sell; away from it approximates a buy.
  if (pair) {
    if (eoas.length) {
      await pushProbe(
        report,
        `EOA -> pair ${short(pair.address)} (sell)`,
        address,
        eoas[0].address,
        pair.address,
        probeAmount(eoas[0])
      )
    }
    await pushProbe(
      report,
      `pair ${short(pair.address)} -> sink (buy)`,
      address,
      pair.address,
      SINK,
      probeAmount(pair)
    )
  }

  if (!report.probes.some((probe) => probe.ok)) {
    report.notes.push('every simulated transfer reverted')
  }

  return finalise(report)
}

async function pushProbe(
  report: TokenReport,
  label: string,
  token: string,
  from: string,
  to: string,
  amount: bigint
) {
  if (amount <= 0n) return

  try {
    report.probes.push(await runProbe(label, token, from, to, amount))
  } catch (error) {
    report.notes.push(
      `probe "${label}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

function finalise(report: TokenReport): TokenReport {
  const successful = report.probes.filter((probe) => probe.ok)

  report.maxTaxBps = successful.reduce(
    (worst, probe) => Math.max(worst, probe.taxBps),
    0
  )
  report.burnsOnTransfer = successful.some((probe) => probe.supplyDelta !== 0n)

  if (report.maxTaxBps >= TAX_TOLERANCE_BPS) {
    report.verdict = 'TAXED'
  } else if (report.rebaseHints.length) {
    report.verdict = 'REBASING'
  } else if (!successful.length) {
    report.verdict = 'UNKNOWN'
  } else if (report.taxHints.length) {
    // Machinery is present but every holder we reached was exempt. Worth a
    // human look rather than an automatic pass.
    report.verdict = 'SUSPICIOUS'
  } else {
    report.verdict = 'CLEAN'
  }

  return report
}

function short(address: string): string {
  return `${address.slice(0, 6)}..${address.slice(-4)}`
}

function colourVerdict(verdict: Verdict): string {
  switch (verdict) {
    case 'CLEAN':
      return chalk.green(verdict)
    case 'TAXED':
      return chalk.red.bold(verdict)
    case 'REBASING':
      return chalk.red(verdict)
    case 'SUSPICIOUS':
      return chalk.yellow(verdict)
    default:
      return chalk.dim(verdict)
  }
}

function printReport(report: TokenReport, verbose: boolean) {
  const name = report.symbol ? `${report.symbol} ` : ''
  const tax =
    report.maxTaxBps > 0 ? chalk.red(` tax=${report.maxTaxBps / 100}%`) : ''

  console.log(
    `${colourVerdict(report.verdict).padEnd(22)} ${name}${short(
      report.address
    )}${tax}`
  )

  if (report.burnsOnTransfer) {
    console.log(
      chalk.dim('    totalSupply changed during transfer (burn/reflect)')
    )
  }
  if (report.taxHints.length) {
    console.log(chalk.dim(`    tax getters: ${report.taxHints.join(', ')}`))
  }
  if (report.rebaseHints.length) {
    console.log(
      chalk.dim(`    rebase getters: ${report.rebaseHints.join(', ')}`)
    )
  }
  for (const note of report.notes) {
    console.log(chalk.dim(`    ${note}`))
  }
  if (verbose) {
    for (const probe of report.probes) {
      console.log(
        chalk.dim(
          `    ${probe.ok ? '✓' : '✗'} ${probe.label}: sent=${probe.sent} ` +
            `recv=${probe.received} tax=${probe.taxBps / 100}%`
        )
      )
    }
  }
}

/** Format generated source with the repo's prettier config so it passes lint. */
function format(source: string, filepath: string): string {
  const options = prettier.resolveConfig.sync(filepath) ?? {}
  return prettier.format(source, { ...options, filepath })
}

/**
 * Strips the given addresses out of a token source file.
 *
 * Both files are flat lists of `'0xabc...', // SYMBOL` lines, so this filters
 * by line rather than parsing and re-emitting. That keeps every comment,
 * grouping and blank line in the file exactly where the author left it - only
 * the offending addresses disappear.
 */
function pruneTokenFile(filepath: string, remove: Set<string>): string[] {
  if (!fs.existsSync(filepath)) return []

  const source = fs.readFileSync(filepath, 'utf8')
  const removed: string[] = []

  const kept = source.split('\n').filter((line) => {
    const match = line.match(/'(0x[0-9a-fA-F]{40})'/)
    if (!match) return true
    if (!remove.has(getAddress(match[1]))) return true
    removed.push(getAddress(match[1]))
    return false
  })

  if (removed.length) {
    fs.writeFileSync(filepath, format(kept.join('\n'), filepath))
  }

  return removed
}

/**
 * Removes every token that failed the check from the source lists.
 *
 * UNKNOWN is deliberately not removed: it means we could not simulate (a token
 * with no supply yet, say), which is not evidence against the token. SUSPICIOUS
 * is left in place too unless --prune-suspicious is passed, since it needs a
 * human read rather than an automatic verdict.
 */
function pruneFailingTokens(reports: TokenReport[], pruneSuspicious: boolean) {
  const failing = reports.filter(
    (report) =>
      report.verdict === 'TAXED' ||
      report.verdict === 'REBASING' ||
      (pruneSuspicious && report.verdict === 'SUSPICIOUS')
  )

  if (!failing.length) {
    console.log(
      chalk.green('\nNothing to remove - every checked token passed.')
    )
    return
  }

  const remove = new Set(failing.map((report) => report.address))

  for (const filepath of TOKEN_FILES) {
    const removed = pruneTokenFile(filepath, remove)
    if (removed.length) {
      console.log(
        chalk.yellow(
          `\nRemoved ${removed.length} token(s) from ${path.basename(
            filepath
          )}:`
        )
      )
      for (const address of removed) console.log(chalk.dim(`  ${address}`))
    }
  }

  console.log(
    chalk.dim('\nRun `npm run generate` to rebuild the tokenlist without them.')
  )
}

function getFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`)
}

function getOption(name: string): string | undefined {
  const argv = process.argv.slice(2)
  const index = argv.findIndex((arg) => arg === `--${name}`)
  if (index !== -1) return argv[index + 1]
  return argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
}

async function resolveTargets(): Promise<
  { address: string; symbol?: string }[]
> {
  const explicit = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith('--') && isAddress(arg))
    .map((arg) => ({ address: getAddress(arg) }))

  if (explicit.length) return explicit

  // Symbols come from the sync script's trailing `// SYMBOL` comments.
  const manual = await import('../../tokenlists/robinhood/tokens/manual')
  const addresses: { address: string; symbol?: string }[] = []

  const push = (list: string[] | undefined) => {
    for (const address of list ?? []) {
      if (isAddress(address)) addresses.push({ address: getAddress(address) })
    }
  }

  push(manual.default[NETWORK])

  if (!getFlag('manual')) {
    const generated = await import(
      '../../tokenlists/robinhood/tokens/robinhood'
    )
    push(generated.default)
  }

  const seen = new Set<string>()
  return addresses.filter((item) => {
    if (seen.has(item.address)) return false
    seen.add(item.address)
    return true
  })
}

async function run() {
  const verbose = getFlag('verbose')
  const jsonPath = getOption('json')
  const targets = await resolveTargets()

  console.log(
    chalk.cyan(
      `Checking ${targets.length} token(s) for transfer tax on ${configs[NETWORK].name}`
    )
  )
  console.log(
    chalk.dim(
      'Simulated via eth_call state overrides - nothing is broadcast on chain.\n'
    )
  )

  const reports: TokenReport[] = []

  for (const target of targets) {
    const report = await checkToken(target.address, target.symbol)
    reports.push(report)
    printReport(report, verbose)
    await sleep(120)
  }

  const counts = reports.reduce<Record<string, number>>((acc, report) => {
    acc[report.verdict] = (acc[report.verdict] ?? 0) + 1
    return acc
  }, {})

  console.log(chalk.cyan('\nSummary'))
  for (const [verdict, count] of Object.entries(counts)) {
    console.log(`  ${colourVerdict(verdict as Verdict)}: ${count}`)
  }

  if (getFlag('write')) {
    pruneFailingTokens(reports, getFlag('prune-suspicious'))
  }

  if (jsonPath) {
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        reports,
        (key, value) => (typeof value === 'bigint' ? value.toString() : value),
        2
      )
    )
    console.log(chalk.dim(`\nWrote ${jsonPath}`))
  }

  const blocked = reports.filter(
    (report) => report.verdict === 'TAXED' || report.verdict === 'REBASING'
  )

  if (blocked.length) {
    console.log(
      chalk.red(
        `\n${blocked.length} token(s) should not be added: ` +
          blocked.map((report) => short(report.address)).join(', ')
      )
    )
    process.exitCode = 1
  }
}

;(async () => {
  try {
    await run()
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
})()
