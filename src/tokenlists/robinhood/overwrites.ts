import { Network, OverwritesForList } from '../../types'
import blockscoutAssets from './assets/blockscout'
import dexscreenerAssets from './assets/dexscreener'
import geckoterminalAssets from './assets/geckoterminal'
import robinhoodAssets from './assets/robinhood'

export const overwrites: OverwritesForList = {
  [Network.Ethereum]: {},
  [Network.Polygon]: {},
  [Network.Arbitrum]: {},
  [Network.Optimism]: {},
  [Network.Gnosis]: {},
  [Network.Zkevm]: {},
  [Network.Robinhood]: {
    // All synced by `npm run robinhood:sync`. Later spreads win, so RHJ asset
    // data beats the logo-only entries, and GeckoTerminal's (mostly CoinGecko-
    // hosted) logos beat DexScreener's. These sit in overwrites rather than
    // fallbacks so they replace logos carried over from the existing list.
    ...dexscreenerAssets,
    ...geckoterminalAssets,
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
    // CoinGecko has no Robinhood deployment for it, so pin the canonical id
    // to price it off frxUSD's mainnet markets.
    '0x00000000D61733e7A393A10A5B48c311AbE8f1E5': {
      logoURI:
        'https://coin-images.coingecko.com/coins/images/53963/small/frxUSD.png?1737792154',
      extensions: { coingeckoId: 'frax-usd' },
    },
    // Tokens with no logo on GeckoTerminal or DexScreener; logos from CoinGecko.
    '0x492641F648a4986844848E0beFE66D14817bCE34': {
      // LINK
      logoURI:
        'https://coin-images.coingecko.com/coins/images/877/large/Chainlink_Logo_500.png?1760023405',
    },
    '0x74BE72AFFAFbC8de30F0C11247814036314D625f': {
      // PENGU
      logoURI:
        'https://coin-images.coingecko.com/coins/images/52622/large/PUDGY_PENGUINS_PENGU_PFP.png?1733809110',
    },
    '0x61a10E8556BEd032eA176330e7F17D6a12a10000': {
      // UUSD
      logoURI:
        'https://coin-images.coingecko.com/coins/images/102172413/large/UUSD.png?1773390929',
    },
    '0x88C4C42ED68584FF02F5a00D5D3D985108A3961C': {
      // EDEL
      logoURI:
        'https://coin-images.coingecko.com/coins/images/70661/large/edel-mark-dark-DKW6ovcZ_%281%29.png?1790067790',
    },
    '0xBD4802d70448fb1D776683bebEa592d66B623e29': {
      // STONKFI
      logoURI:
        'https://coin-images.coingecko.com/coins/images/102175651/large/x-profile-1024.png?1787342980',
    },
  },
}
