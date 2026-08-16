import { ChildProcess, spawn } from 'child_process'
import { BigNumber, providers, utils, Wallet } from 'ethers'

export interface AnvilInstance {
  provider: providers.JsonRpcProvider
  stop: () => void
}

const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'

/**
 * Boots an anvil fork of BNB Chain so SDK generated calldata can be executed against the real
 * Topaz pools rather than mocks.
 */
export async function startAnvilFork({
  rpcUrl,
  blockNumber,
  port
}: {
  rpcUrl: string
  blockNumber?: number
  port: number
}): Promise<AnvilInstance> {
  const args = [
    '--fork-url',
    rpcUrl,
    '--port',
    String(port),
    '--mnemonic',
    ANVIL_MNEMONIC,
    '--silent',
    '--no-rate-limit'
  ]
  if (blockNumber) args.push('--fork-block-number', String(blockNumber))

  const child: ChildProcess = spawn('anvil', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr?.on('data', chunk => {
    stderr += String(chunk)
  })

  const provider = new providers.JsonRpcProvider(`http://127.0.0.1:${port}`, 56)

  const deadline = Date.now() + 60_000
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`anvil exited with code ${child.exitCode}: ${stderr}`)
    }
    try {
      await provider.getBlockNumber()
      break
    } catch {
      if (Date.now() > deadline) {
        child.kill('SIGKILL')
        throw new Error(`anvil did not become ready within 60s: ${stderr}`)
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  return {
    provider,
    stop: () => {
      provider.removeAllListeners()
      child.kill('SIGKILL')
    }
  }
}

/** A free-ish port, derived from the process id so parallel jest workers do not collide */
export function pickPort(offset = 0): number {
  return 18_000 + (process.pid % 2_000) + offset
}

/**
 * Funds a wallet derived from a key private to this repo.
 *
 * Anvil's default accounts cannot be used against a BNB Chain fork: their keys are public, and
 * someone has already installed an EIP-7702 delegation on those addresses on mainnet that forwards
 * any incoming BNB to a sweeper. Forked state carries that delegation, so native output silently
 * leaves the test account.
 */
export async function createFundedWallet(
  provider: providers.JsonRpcProvider,
  label = 'topaz-universal-test-account',
  balance = utils.parseEther('10000')
): Promise<Wallet> {
  const wallet = new Wallet(utils.keccak256(utils.toUtf8Bytes(label)), provider)
  const code = await provider.getCode(wallet.address)
  if (code !== '0x') throw new Error(`test account ${wallet.address} has code on the forked chain`)
  await provider.send('anvil_setBalance', [wallet.address, BigNumber.from(balance).toHexString()])
  return wallet
}
