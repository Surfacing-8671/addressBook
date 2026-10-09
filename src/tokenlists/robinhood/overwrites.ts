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
    // steakUSDG - Morpho ERC4626 vault over USDG, so it borrows USDG's logo.
    '0xBeEff033F34C046626B8D0A041844C5d1A5409dd': {
      symbol: 'steakUSDG',
      logoURI:
        'https://assets.coingecko.com/coins/images/51281/standard/GDN_USDG_Token_200x200.png?1730484111',
    },
    // frxUSD - Frax USD. Not synced from Blockscout, so it needs a logo here.
    '0x00000000D61733e7A393A10A5B48c311AbE8f1E5': {
      logoURI:
        'https://coin-images.coingecko.com/coins/images/53963/small/frxUSD.png?1737792154',
    },
  },
}
