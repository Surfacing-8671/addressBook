import { Network, TokensForList } from '../../types'
import robinhood from './tokens/robinhood'

export const tokens: TokensForList = {
  [Network.Ethereum]: [],
  [Network.Polygon]: [],
  [Network.Arbitrum]: [],
  [Network.Optimism]: [],
  [Network.Gnosis]: [],
  [Network.Zkevm]: [],
  [Network.Base]: [],
  [Network.HyperEVM]: [],
  [Network.Avalanche]: [],
  [Network.Sepolia]: [],
  [Network.Fantom]: [],
  [Network.Fraxtal]: [],
  [Network.Mode]: [],
  [Network.Sonic]: [],
  [Network.Plasma]: [],
  [Network.XLayer]: [],
  [Network.Monad]: [],
  [Network.Robinhood]: robinhood,
}
