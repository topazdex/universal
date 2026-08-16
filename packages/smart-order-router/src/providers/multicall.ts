import { Interface } from '@ethersproject/abi'
import { BigNumber } from '@ethersproject/bignumber'
import { BaseProvider } from '@ethersproject/providers'

import { MULTICALL3_ADDRESS } from '../constants'

const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)'
]

export interface Call {
  target: string
  callData: string
}

export interface CallResult {
  success: boolean
  returnData: string
}

export interface MulticallOptions {
  /** Calls per eth_call. Quoter calls are heavy, so the default is deliberately small. */
  batchSize?: number
  blockTag?: number | string
  /** Optional gas ceiling per inner call; left unset the node applies its own cap */
  gasLimitPerCall?: number
}

/**
 * Batches read calls through Multicall3.
 *
 * Quoter entrypoints are state mutating (they revert to return their answer), so they can only be
 * read through `eth_call`. `aggregate3` lets one failing quote come back as `success: false`
 * instead of taking the whole batch down.
 *
 * A whole batch can still fail — typically when simulating that many swaps exceeds the node's gas
 * cap for `eth_call`, which differs between anvil, a public RPC and a paid one. Rather than tune a
 * batch size per provider, a failed batch is halved and retried until it succeeds or a single call
 * is isolated as genuinely failing.
 */
export class MulticallProvider {
  private readonly multicallInterface = new Interface(MULTICALL3_ABI)

  public constructor(private readonly provider: BaseProvider) {}

  public async call(calls: Call[], options: MulticallOptions = {}): Promise<CallResult[]> {
    const batchSize = options.batchSize ?? 40
    const results: CallResult[] = []

    for (let i = 0; i < calls.length; i += batchSize) {
      results.push(...(await this.callBatch(calls.slice(i, i + batchSize), options)))
    }

    return results
  }

  private async callBatch(calls: Call[], options: MulticallOptions): Promise<CallResult[]> {
    if (calls.length === 0) return []

    try {
      return await this.callOnce(calls, options)
    } catch (error) {
      if (calls.length === 1) {
        return [{ success: false, returnData: '0x' }]
      }
      const middle = Math.ceil(calls.length / 2)
      const [left, right] = await Promise.all([
        this.callBatch(calls.slice(0, middle), options),
        this.callBatch(calls.slice(middle), options)
      ])
      return [...left, ...right]
    }
  }

  private async callOnce(calls: Call[], options: MulticallOptions): Promise<CallResult[]> {
    const calldata = this.multicallInterface.encodeFunctionData('aggregate3', [
      calls.map(call => ({ target: call.target, allowFailure: true, callData: call.callData }))
    ])

    const request: { to: string; data: string; gasLimit?: BigNumber } = {
      to: MULTICALL3_ADDRESS,
      data: calldata
    }
    if (options.gasLimitPerCall) {
      request.gasLimit = BigNumber.from(options.gasLimitPerCall).mul(calls.length)
    }

    const raw = await this.provider.call(request, options.blockTag)
    const [decoded] = this.multicallInterface.decodeFunctionResult('aggregate3', raw)

    return decoded.map((entry: { success: boolean; returnData: string }) => ({
      success: entry.success,
      returnData: entry.returnData
    }))
  }
}
