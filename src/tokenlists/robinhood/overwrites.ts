import { Network, OverwritesForList } from '../../types'
import robinhoodAssets from './assets/robinhood'

export const overwrites: OverwritesForList = {
  [Network.Ethereum]: {},
  [Network.Polygon]: {},
  [Network.Arbitrum]: {},
  [Network.Optimism]: {},
  [Network.Gnosis]: {},
  [Network.Zkevm]: {},
  [Network.Robinhood]: {
    // Synced from the RHJ assets API by `npm run robinhood:sync`.
    // Add manual overrides below this spread so they take precedence.
    ...robinhoodAssets,
  },
}
