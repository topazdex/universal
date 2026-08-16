import { Interface } from '@ethersproject/abi'
import { Currency, CurrencyAmount } from '@uniswap/sdk-core'

import { MixedRoute } from '../entities/mixedRoute'
import { encodeMixedRouteToPath } from './encodeMixedRouteToPath'

export const MIXED_ROUTE_QUOTER_V1_ABI = [
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] v3SqrtPriceX96AfterList, uint32[] v3InitializedTicksCrossedList, uint256 v3SwapGasEstimate)'
]

/** Builds calldata for the deployed Topaz `MixedRouteQuoterV1` */
export abstract class MixedRouteQuoter {
  public static INTERFACE: Interface = new Interface(MIXED_ROUTE_QUOTER_V1_ABI)

  public static quoteExactInputCallParameters(
    route: MixedRoute<Currency, Currency>,
    amountIn: CurrencyAmount<Currency>
  ): { calldata: string; value: string } {
    return {
      calldata: MixedRouteQuoter.INTERFACE.encodeFunctionData('quoteExactInput', [
        encodeMixedRouteToPath(route),
        amountIn.quotient.toString()
      ]),
      value: '0x00'
    }
  }
}
