import { Interface } from '@ethersproject/abi'
import { BigNumber } from '@ethersproject/bignumber'
import { BaseProvider } from '@ethersproject/providers'

import { MULTICALL3_ADDRESS, MULTICALL_CONCURRENCY, QUOTE_BATCH_SIZE } from '../constants'

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
  /** Batches in flight at once. Latency is dominated by round trips, not by local work. */
  concurrency?: number
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

  public constructor(
    private readonly provider: BaseProvider,
    /** Defaults for every call, so batching can be tuned to an RPC provider without a rebuild */
    private readonly defaults: MulticallOptions = {},
    private readonly address: string = MULTICALL3_ADDRESS
  ) {}

  public async call(calls: Call[], callOptions: MulticallOptions = {}): Promise<CallResult[]> {
    // an explicitly undefined per-call option must not clobber a configured default
    const defined = Object.fromEntries(Object.entries(callOptions).filter(([, value]) => value !== undefined))
    const options: MulticallOptions = { ...this.defaults, ...defined }
    const batchSize = options.batchSize ?? QUOTE_BATCH_SIZE
    const concurrency = options.concurrency ?? MULTICALL_CONCURRENCY

    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid Multicall limits')
    const batches: Call[][] = []
    for (let i = 0; i < calls.length; i += batchSize) {
      batches.push(calls.slice(i, i + batchSize))
    }

    // batches are independent reads at a fixed block, so run several at once; a quote's wall clock
    // is almost entirely RPC round trips
    const results: CallResult[][] = new Array(batches.length)
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++
        if (index >= batches.length) return
        results[index] = await this.callBatch(batches[index], options)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker))

    return results.flat()
  }

  private async callBatch(calls: Call[], options: MulticallOptions): Promise<CallResult[]> {
    if (calls.length === 0) return []

    try {
      return await this.callOnce(calls, options)
    } catch (error) {
      if (!isGasCeiling(error)) throw error
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
      to: this.address,
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

interface NestedError {
  message?: string
  code?: string
  error?: unknown
}

/**
 * True only when the node executed the batch and rejected it for gas or a revert, so halving it
 * can help. Anything else — a timeout, a 429, a socket error, a spent quote budget — would fail
 * identically for both halves, and splitting would just turn one failed request into many.
 *
 * ethers' `perform('call')` wraps *every* send failure in a CALL_EXCEPTION whose message says
 * "missing revert data", with the real error nested under `error`, so the transport error has to
 * be dug out from the innermost cause before it can be classified.
 */
function isGasCeiling(error: unknown): boolean {
  let cause = error as NestedError | undefined
  while (cause?.error) cause = cause.error as NestedError
  const message = String(cause?.message ?? '').toLowerCase()
  // geth says "out of gas", anvil "EVM error OutOfGas"
  if (/execution reverted|out ?of ?gas|gas required exceeds|gas limit/.test(message)) return true
  // a CALL_EXCEPTION with nothing nested is ethers reporting revert data it could not decode
  return cause === error && (error as NestedError).code === 'CALL_EXCEPTION'
}
