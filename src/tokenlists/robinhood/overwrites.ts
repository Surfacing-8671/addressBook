import { Network, OverwritesForList } from '../../types'
import blockscoutAssets from './assets/blockscout'
import robinhoodAssets from './assets/robinhood'

export const overwrites: OverwritesForList = {
  [Network.Ethereum]: {},
  [Network.Polygon]: {},
  [Network.Arbitrum]: {},
  [Network.Optimism]: {},
  [Network.Gnosis]: {},
  [Network.Zkevm]: {},
  [Network.Robinhood]: {
    // Both synced by `npm run robinhood:sync`. Later spreads win, so RHJ asset
    // data beats Blockscout's logo-only entries.
    ...blockscoutAssets,
    ...robinhoodAssets,
    // Add manual overrides below this line so they take precedence.
  },
}
