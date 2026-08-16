import { Interface } from '@ethersproject/abi'
import { BigintIsh, Currency, CurrencyAmount, TradeType } from '@uniswap/sdk-core'

import { Route } from './entities'
import { encodeRouteToPath, MethodParameters, toHex } from './utils'

/** Topaz CL QuoterV2, keyed by tick spacing rather than fee */
export const QUOTER_V2_ABI = [
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactOutput(bytes path, uint256 amountOut) returns (uint256 amountIn, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
  'function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
]

export interface QuoteOptions {
  /** The optional price limit for the trade */
  sqrtPriceLimitX96?: BigintIsh
}

/**
 * Builds calldata for the deployed Topaz `QuoterV2`.
 */
export abstract class SwapQuoter {
  public static INTERFACE: Interface = new Interface(QUOTER_V2_ABI)

  /**
   * Produces the calldata that quotes `amount` along `route`.
   *
   * Single hop routes use the `…Single` entrypoints, which take a tick spacing; multi hop routes
   * use the path entrypoints, where the tick spacing travels inside the encoded path.
   */
  public static quoteCallParameters<TInput extends Currency, TOutput extends Currency>(
    route: Route<TInput, TOutput>,
    amount: CurrencyAmount<TInput | TOutput>,
    tradeType: TradeType,
    options: QuoteOptions = {}
  ): MethodParameters {
    const quoteAmount = toHex(amount.quotient)
    const sqrtPriceLimitX96 = toHex(options?.sqrtPriceLimitX96 ?? 0)
    const singleHop = route.pools.length === 1

    let calldata: string
    if (singleHop) {
      const tokenIn = route.tokenPath[0].address
      const tokenOut = route.tokenPath[1].address
      const tickSpacing = route.pools[0].tickSpacing

      calldata =
        tradeType === TradeType.EXACT_INPUT
          ? SwapQuoter.INTERFACE.encodeFunctionData('quoteExactInputSingle', [
              { tokenIn, tokenOut, amountIn: quoteAmount, tickSpacing, sqrtPriceLimitX96 }
            ])
          : SwapQuoter.INTERFACE.encodeFunctionData('quoteExactOutputSingle', [
              { tokenIn, tokenOut, amount: quoteAmount, tickSpacing, sqrtPriceLimitX96 }
            ])
    } else {
      const path = encodeRouteToPath(route, tradeType === TradeType.EXACT_OUTPUT)
      calldata =
        tradeType === TradeType.EXACT_INPUT
          ? SwapQuoter.INTERFACE.encodeFunctionData('quoteExactInput', [path, quoteAmount])
          : SwapQuoter.INTERFACE.encodeFunctionData('quoteExactOutput', [path, quoteAmount])
    }

    return { calldata, value: toHex(0) }
  }
}
