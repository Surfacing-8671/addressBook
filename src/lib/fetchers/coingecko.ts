import { TokenInfo } from '@uniswap/token-lists'
import chalk from 'chalk'
import { Network } from '../../types'
import { sleep } from '../utils'
import config from '../../config'
import { getAddress, isAddress } from 'ethers'

const apiKey = process.env.COINGECKO_API_KEY

const PRO_BASE_URL = 'https://pro-api.coingecko.com/api/v3'
const PUBLIC_BASE_URL = 'https://api.coingecko.com/api/v3'

interface CoingeckoApi {
  baseUrl: string
  apiKeyParam: string
  isPro: boolean
}

let apiPromise: Promise<CoingeckoApi> | undefined

/**
 * Demo and Pro keys share the same `CG-` prefix but each is only accepted by
 * its own host, so the plan is resolved once against /ping rather than guessed.
 */
async function resolveApi(): Promise<CoingeckoApi> {
  if (!apiPromise) {
    apiPromise = (async () => {
      const demo: CoingeckoApi = {
        baseUrl: PUBLIC_BASE_URL,
        apiKeyParam: apiKey ? `x_cg_demo_api_key=${apiKey}` : '',
        isPro: false,
      }
      if (!apiKey) return demo

      const pro: CoingeckoApi = {
        baseUrl: PRO_BASE_URL,
        apiKeyParam: `x_cg_pro_api_key=${apiKey}`,
        isPro: true,
      }

      try {
        const response = await fetch(`${pro.baseUrl}/ping?${pro.apiKeyParam}`)
        if (response.status === 200) return pro
      } catch (e) {
        console.warn(chalk.dim('Coingecko: pro API unreachable'), e)
      }

      console.log(chalk.dim('Coingecko: using demo API key'))
      return demo
    })()
  }

  return apiPromise
}

let callIndex = 0

export async function fetchCoingeckoMetadata(
  network: Network,
  address: string
): Promise<Partial<TokenInfo> | undefined> {
  try {
    const { baseUrl, apiKeyParam, isPro } = await resolveApi()

    callIndex++
    // Coingecko rate limits their API to 10 calls/second if we dont use pro
    if (!isPro) {
      if (callIndex > 0 && callIndex % 10 === 0) {
        console.log(chalk.dim('Waiting for 2s to avoid Coingecko rate limit'))
        await sleep(3000)
      }
    }

    const response = await fetch(
      `${baseUrl}/coins/${
        config[network].coingecko.platformId
      }/contract/${address.toLowerCase()}?${apiKeyParam}`
    )

    if (response.status !== 200) {
      throw new Error('Coingecko API error, status: ' + response.statusText)
    }

    const data = await response.json()

    const {
      name,
      symbol,
      image: { large: logoURI },
    } = data

    return {
      address,
      name,
      symbol,
      logoURI,
    }
  } catch (e) {
    console.log(e)
    console.log(chalk.dim(`Coingecko (not found): ${address}`))
    return undefined
  }
}

interface CoingeckoCoin {
  id: string
  platforms?: Record<string, string | null>
}

let coinsListPromise: Promise<CoingeckoCoin[]> | undefined

/**
 * The full coin list covers every asset platform in one response, so it's
 * fetched once and shared by all networks in a build.
 */
async function fetchCoinsList(): Promise<CoingeckoCoin[]> {
  if (!coinsListPromise) {
    coinsListPromise = (async () => {
      const { baseUrl, apiKeyParam } = await resolveApi()

      const response = await fetch(
        `${baseUrl}/coins/list?include_platform=true&${apiKeyParam}`
      )

      if (response.status !== 200) {
        throw new Error('Coingecko API error, status: ' + response.statusText)
      }

      return response.json()
    })()
  }

  try {
    return await coinsListPromise
  } catch (e) {
    // Don't cache a failure, so a transient error doesn't kill every network.
    coinsListPromise = undefined
    throw e
  }
}

/**
 * Maps checksummed token address -> Coingecko coin id for a network, for
 * consumers that price the list. Returns an empty map if Coingecko is
 * unreachable or doesn't index the network's platform.
 */
export async function fetchCoingeckoIds(
  network: Network
): Promise<Record<string, string>> {
  const { platformId } = config[network].coingecko

  try {
    const coins = await fetchCoinsList()
    const ids: Record<string, string> = {}

    for (const coin of coins) {
      const address = coin.platforms?.[platformId]
      if (!address || !isAddress(address)) continue
      ids[getAddress(address)] = coin.id
    }

    return ids
  } catch (e) {
    console.warn(
      chalk.yellow(`Failed to fetch Coingecko ids for platform ${platformId}`),
      e
    )
    return {}
  }
}
