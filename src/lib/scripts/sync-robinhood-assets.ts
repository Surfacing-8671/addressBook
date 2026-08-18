/**
 * Syncs the Robinhood tokenized-equity list from the public RHJ assets API.
 *
 * 1. Fetches https://api.robinhood.com/rhj/assets
 * 2. Keeps active assets with a deployment on Robinhood Chain.
 * 3. Writes the checksummed addresses to tokens/robinhood.ts
 * 4. Writes name/symbol/decimals/logoURI to assets/robinhood.ts, which
 *    overwrites.ts spreads in as top-priority metadata for the generator.
 *
 * Example usage:
 * npm run robinhood:sync
 */

import fs from 'fs'
import path from 'path'
import chalk from 'chalk'
import { getAddress, isAddress } from 'ethers'
import { Network } from '../../types'
import { sleep } from '../utils'

const ASSETS_URL = 'https://api.robinhood.com/rhj/assets'
const BLOCKSCOUT_URL = 'https://robinhoodchain.blockscout.com/api/v2/tokens/'
// Blockscout's cursor wraps back to page 1 rather than ending, so this is only
// a backstop; the real stop condition is a page that adds no new addresses.
const MAX_BLOCKSCOUT_PAGES = 40
const ACTIVE_STATUS = 'ASSET_STATUS_ACTIVE'
const CHAIN_ID = Number(Network.Robinhood)

const tokenlistPath = path.resolve(__dirname, '../../tokenlists/robinhood')
const tokensFile = path.resolve(tokenlistPath, 'tokens/robinhood.ts')
const assetsFile = path.resolve(tokenlistPath, 'assets/robinhood.ts')
const blockscoutFile = path.resolve(tokenlistPath, 'assets/blockscout.ts')

interface RhjDeployment {
  contractAddress: string
  chainId: number
  networkName: string
}

interface RhjAsset {
  id: string
  tokenSymbol: string
  tokenName: string
  tokenDecimals: number
  status: string
  logoUrl?: string
  deployments: RhjDeployment[]
}

interface RhjAssetsResponse {
  assets: RhjAsset[]
}

interface BlockscoutToken {
  address_hash: string
  symbol: string | null
  icon_url: string | null
}

interface BlockscoutPage {
  items: BlockscoutToken[]
  next_page_params: Record<string, unknown> | null
}

interface RobinhoodToken {
  address: string
  name: string
  symbol: string
  decimals: number
  logoURI?: string
}

// prettier ships no type declarations on v2, so require it with a local shape.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const prettier = require('prettier') as {
  format(source: string, options: Record<string, unknown>): string
  resolveConfig: { sync(filepath: string): Record<string, unknown> | null }
}

/** Format generated source with the repo's prettier config so it passes lint. */
function format(source: string, filepath: string): string {
  const options = prettier.resolveConfig.sync(filepath) ?? {}
  return prettier.format(source, { ...options, filepath })
}

async function fetchAssets(): Promise<RhjAsset[]> {
  const response = await fetch(ASSETS_URL, {
    headers: { accept: 'application/json' },
  })

  if (!response.ok) {
    throw new Error(
      `Robinhood assets API error: ${response.status} ${response.statusText}`
    )
  }

  const data = (await response.json()) as RhjAssetsResponse

  if (!Array.isArray(data?.assets)) {
    throw new Error('Unexpected Robinhood assets API response shape')
  }

  return data.assets
}

function encodePageParams(params: Record<string, unknown>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue
    query.set(key, String(value))
  }
  return query.toString()
}

/**
 * Collects address -> icon URL from the Blockscout token index.
 *
 * Blockscout paginates 50 at a time and never returns a null next_page_params:
 * past the last page the cursor wraps around to page 1 and cycles forever. So
 * the loop stops once a page contributes no addresses it has not already seen.
 *
 * Failures here are non-fatal — Blockscout only supplements logos, and the RHJ
 * feed is the source of record for the tokenized equities.
 */
async function fetchBlockscoutIcons(): Promise<Map<string, string>> {
  const icons = new Map<string, string>()
  const seen = new Set<string>()
  let params: Record<string, unknown> | null = null

  try {
    for (let page = 0; page < MAX_BLOCKSCOUT_PAGES; page++) {
      const query = params ? `?${encodePageParams(params)}` : ''
      const response = await fetch(`${BLOCKSCOUT_URL}${query}`, {
        headers: { accept: 'application/json' },
      })

      if (!response.ok) {
        throw new Error(
          `Blockscout API error: ${response.status} ${response.statusText}`
        )
      }

      const data = (await response.json()) as BlockscoutPage
      if (!Array.isArray(data?.items)) {
        throw new Error('Unexpected Blockscout response shape')
      }

      let added = 0
      for (const token of data.items) {
        if (!isAddress(token.address_hash)) continue
        const address = getAddress(token.address_hash)
        if (seen.has(address)) continue
        seen.add(address)
        added++
        if (token.icon_url) icons.set(address, token.icon_url)
      }

      // Cursor has wrapped around; every address on this page was a repeat.
      if (added === 0) break
      if (!data.next_page_params) break
      params = data.next_page_params

      await sleep(150)
    }
  } catch (error) {
    console.warn(chalk.yellow('Failed to fetch Blockscout icons'), error)
    return icons
  }

  console.log(
    chalk.dim(`Blockscout: ${seen.size} tokens, ${icons.size} with icons`)
  )
  return icons
}

function toTokens(assets: RhjAsset[]): RobinhoodToken[] {
  const tokens: RobinhoodToken[] = []
  const seen = new Set<string>()

  for (const asset of assets) {
    if (asset.status !== ACTIVE_STATUS) {
      console.log(chalk.dim(`Skipping ${asset.tokenSymbol}: ${asset.status}`))
      continue
    }

    const deployment = asset.deployments?.find(
      (item) => item.chainId === CHAIN_ID
    )
    if (!deployment) {
      console.log(
        chalk.dim(
          `Skipping ${asset.tokenSymbol}: no chain ${CHAIN_ID} deployment`
        )
      )
      continue
    }

    if (!isAddress(deployment.contractAddress)) {
      console.warn(
        chalk.yellow(
          `Skipping ${asset.tokenSymbol}: invalid address ${deployment.contractAddress}`
        )
      )
      continue
    }

    const address = getAddress(deployment.contractAddress)
    if (seen.has(address)) {
      console.warn(chalk.yellow(`Skipping duplicate address: ${address}`))
      continue
    }
    seen.add(address)

    tokens.push({
      address,
      name: asset.tokenName,
      symbol: asset.tokenSymbol,
      decimals: Number(asset.tokenDecimals),
      logoURI: asset.logoUrl || undefined,
    })
  }

  // Sort by symbol so regenerating produces stable diffs.
  return tokens.sort((a, b) => a.symbol.localeCompare(b.symbol))
}

function buildTokensFile(tokens: RobinhoodToken[]): string {
  const lines = tokens.map(
    (token) => `  '${token.address}', // ${token.symbol}`
  )

  return [
    '// Auto-generated by `npm run robinhood:sync`. Do not edit by hand.',
    `// Source: ${ASSETS_URL}`,
    '',
    'export default [',
    ...lines,
    ']',
    '',
  ].join('\n')
}

function buildAssetsFile(tokens: RobinhoodToken[]): string {
  const entries = tokens.map((token) => {
    const fields = [
      `    name: ${JSON.stringify(token.name)},`,
      `    symbol: ${JSON.stringify(token.symbol)},`,
      `    decimals: ${token.decimals},`,
    ]
    if (token.logoURI) {
      fields.push(`    logoURI: ${JSON.stringify(token.logoURI)},`)
    }
    return [`  '${token.address}': {`, ...fields, '  },'].join('\n')
  })

  return [
    '// Auto-generated by `npm run robinhood:sync`. Do not edit by hand.',
    `// Source: ${ASSETS_URL}`,
    '',
    "import { TokenInfo } from '@uniswap/token-lists'",
    '',
    'const assets: Record<string, Partial<TokenInfo>> = {',
    ...entries,
    '}',
    '',
    'export default assets',
    '',
  ].join('\n')
}

function buildBlockscoutFile(icons: Map<string, string>): string {
  const entries = [...icons.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([address, logoURI]) =>
        `  '${address}': {\n    logoURI: ${JSON.stringify(logoURI)},\n  },`
    )

  return [
    '// Auto-generated by `npm run robinhood:sync`. Do not edit by hand.',
    `// Source: ${BLOCKSCOUT_URL}`,
    '//',
    '// Logo URLs only. Lower priority than the RHJ asset data, so this mainly',
    '// supplies icons for non-equity tokens added via tokens/manual.ts.',
    '',
    "import { TokenInfo } from '@uniswap/token-lists'",
    '',
    'const assets: Record<string, Partial<TokenInfo>> = {',
    ...entries,
    '}',
    '',
    'export default assets',
    '',
  ].join('\n')
}

async function run() {
  console.log(chalk.cyan(`Fetching Robinhood assets from ${ASSETS_URL}`))
  const assets = await fetchAssets()
  console.log(chalk.dim(`Received ${assets.length} assets`))

  console.log(chalk.cyan(`Fetching token icons from ${BLOCKSCOUT_URL}`))
  const blockscoutIcons = await fetchBlockscoutIcons()

  const tokens = toTokens(assets)
  if (!tokens.length) {
    throw new Error('No usable Robinhood assets returned; refusing to write')
  }

  fs.writeFileSync(tokensFile, format(buildTokensFile(tokens), tokensFile))
  fs.writeFileSync(assetsFile, format(buildAssetsFile(tokens), assetsFile))
  fs.writeFileSync(
    blockscoutFile,
    format(buildBlockscoutFile(blockscoutIcons), blockscoutFile)
  )

  const withLogos = tokens.filter((token) => token.logoURI).length
  console.log(
    chalk.green(
      `Wrote ${tokens.length} tokens (${withLogos} with logos) and ` +
        `${blockscoutIcons.size} Blockscout icons to src/tokenlists/robinhood/`
    )
  )
  console.log(chalk.dim('Run `npm run generate` to rebuild the tokenlist.'))
}

;(async () => {
  try {
    await run()
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
})()
