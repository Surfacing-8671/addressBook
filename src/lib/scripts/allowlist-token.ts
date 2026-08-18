/**
 * 1. Takes network, token address and optional token symbol from the CLI.
 * 2. Injects the address into the manual token list for that network.
 * 3. Writes the new file content back to tokens/manual.ts.
 *
 * Args are read straight from argv rather than via cac, because cac's parser
 * coerces `0x...` addresses into numbers before we can read them.
 *
 * Example usage:
 * npm run token:add -- --network robinhood --tokenAddress 0x... --tokenSymbol FOO
 */

import { isAddress } from 'ethers'
import { allowListToken } from './edit-tokenlist'
import configs from '../../config'
import { Config } from '../../types'

function getArg(name: string): string | undefined {
  const argv = process.argv.slice(2)
  const index = argv.findIndex((arg) => arg === `--${name}`)
  if (index !== -1) return argv[index + 1]

  const inline = argv.find((arg) => arg.startsWith(`--${name}=`))
  return inline?.slice(name.length + 3)
}

const tokenAddress = (getArg('tokenAddress') ?? '').replace(
  /[^0-9a-fA-Fx]+/g,
  ''
)
const network = (getArg('network') ?? '').toLowerCase()
const tokenSymbol = getArg('tokenSymbol') ?? ''

validateInput({ network, tokenAddress })

console.log(`🛠️  Adding ${tokenAddress} to ${network} allow list.`)

allowListToken({
  network,
  tokenAddress,
  tokenSymbol,
})

function validateInput({
  network,
  tokenAddress,
}: {
  network: string
  tokenAddress: string
}) {
  const networkNames = Object.values(configs).map(
    (config: Config) => config.name
  )
  if (!networkNames.includes(network)) {
    throw Error(
      `Invalid network name: "${network}". Expected one of: ${networkNames.join(
        ', '
      )}`
    )
  }

  if (!isAddress(tokenAddress)) {
    throw Error(`Provided address (${tokenAddress}) is not a valid address.`)
  }
}
