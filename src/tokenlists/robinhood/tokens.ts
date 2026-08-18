import { getAddress } from 'ethers'
import { Network, TokensForList } from '../../types'
import generated from './tokens/robinhood'
import manual from './tokens/manual'

/** Checksums, dedupes and merges per-network address lists. */
function mergeTokens(
  ...sources: Partial<Record<Network, string[]>>[]
): TokensForList {
  const merged = {} as TokensForList

  for (const network of Object.values(Network)) {
    const addresses = new Set<string>()
    for (const source of sources) {
      for (const address of source[network] ?? []) {
        addresses.add(getAddress(address))
      }
    }
    merged[network] = [...addresses]
  }

  return merged
}

// Generated first, manual second — dedupe keeps either, order is cosmetic.
export const tokens: TokensForList = mergeTokens(
  { [Network.Robinhood]: generated },
  manual
)
