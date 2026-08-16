import { Interface } from '@ethersproject/abi'
import { BigNumber } from '@ethersproject/bignumber'
import {
  AnyRoute,
  isCLPool,
  MixedRoute,
  partitionMixedRouteByProtocol,
  Protocol,
  routePath,
  Swap,
  TPool,
  Trade
} from '@topaz/router-sdk'
import { Pool as V2Pool } from '@topaz/v2-sdk'
import { encodeRouteToPath, Pool as CLPool, Route as CLRoute } from '@topaz/v3-sdk'
import { Currency, CurrencyAmount, Percent, Token, TradeType } from '@uniswap/sdk-core'
import invariant from 'tiny-invariant'

import { CONTRACT_BALANCE, ETH_ADDRESS, ROUTER_AS_RECIPIENT, SENDER_AS_RECIPIENT } from './constants'
import { CommandType, RoutePlanner } from './utils/routerCommands'

export const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
  'function execute(bytes commands, bytes[] inputs) payable'
]

export interface MethodParameters {
  calldata: string
  value: string
}

export interface FeeOptions {
  /** Portion of the output taken as an interface fee */
  fee: Percent
  recipient: string
}

export interface Permit2PermitDetails {
  token: string
  amount: string
  expiration: string | number
  nonce: string | number
}

export interface Permit2Permit {
  details: Permit2PermitDetails
  spender: string
  sigDeadline: string | number
  signature: string
}

export interface SwapOptions {
  slippageTolerance: Percent
  /** Defaults to the transaction sender */
  recipient?: string
  /** Unix seconds. Omit to encode `execute(commands, inputs)` without a deadline check */
  deadline?: string | number
  /** A signed Permit2 allowance, applied before any funds are pulled */
  inputTokenPermit?: Permit2Permit
  fee?: FeeOptions
  /** Route output through the router and sweep it out, even when not otherwise required */
  safeMode?: boolean
}

/**
 * Encodes Topaz trades as Universal Router calldata.
 *
 * A trade may hold several routes (a split) and a route may cross both stacks (a mixed route);
 * both become consecutive commands, with intermediate funds held by the router.
 */
export abstract class SwapRouter {
  public static INTERFACE: Interface = new Interface(UNIVERSAL_ROUTER_ABI)

  public static swapCallParameters(
    trade: Trade<Currency, Currency, TradeType>,
    options: SwapOptions
  ): MethodParameters {
    const planner = new RoutePlanner()

    const inputIsNative = trade.inputAmount.currency.isNative
    const outputIsNative = trade.outputAmount.currency.isNative
    invariant(!(inputIsNative && outputIsNative), 'NATIVE_TO_NATIVE')

    if (options.inputTokenPermit) {
      invariant(!inputIsNative, 'NATIVE_INPUT_PERMIT')
      planner.addCommand(CommandType.PERMIT2_PERMIT, [options.inputTokenPermit, options.inputTokenPermit.signature])
    }

    const maximumAmountIn = trade.maximumAmountIn(options.slippageTolerance)
    if (inputIsNative) {
      planner.addCommand(CommandType.WRAP_ETH, [ROUTER_AS_RECIPIENT, maximumAmountIn.quotient.toString()])
    }
    // native input has already been wrapped into the router, so the router pays from its own balance
    const payerIsUser = !inputIsNative

    const routerMustCustody =
      outputIsNative || options.fee !== undefined || options.safeMode === true || trade.swaps.length > 1
    const swapRecipient = routerMustCustody ? ROUTER_AS_RECIPIENT : options.recipient ?? SENDER_AS_RECIPIENT

    for (const swap of trade.swaps) {
      SwapRouter.addSwap(planner, trade, swap, options, swapRecipient, routerMustCustody, payerIsUser)
    }

    const minimumAmountOut = trade.minimumAmountOut(options.slippageTolerance)
    const minimumAmountOutAfterFee = options.fee
      ? minimumAmountOut.subtract(minimumAmountOut.multiply(options.fee.fee))
      : minimumAmountOut
    const finalRecipient = options.recipient ?? SENDER_AS_RECIPIENT

    if (routerMustCustody) {
      const outputToken = outputIsNative ? ETH_ADDRESS : (trade.outputAmount.currency as Token).address

      // a fee on native output has to be paid after unwrapping: until then the router holds WBNB,
      // and paying a portion of its (empty) BNB balance would hand the collector nothing
      if (outputIsNative && options.fee) {
        planner.addCommand(CommandType.UNWRAP_WETH, [ROUTER_AS_RECIPIENT, minimumAmountOut.quotient.toString()])
      }

      if (options.fee) {
        planner.addCommand(CommandType.PAY_PORTION, [
          outputToken,
          options.fee.recipient,
          options.fee.fee.multiply(10_000).quotient.toString()
        ])
      }

      if (outputIsNative && !options.fee) {
        planner.addCommand(CommandType.UNWRAP_WETH, [finalRecipient, minimumAmountOutAfterFee.quotient.toString()])
      } else {
        planner.addCommand(CommandType.SWEEP, [
          outputToken,
          finalRecipient,
          minimumAmountOutAfterFee.quotient.toString()
        ])
      }
    }

    // an exact output trade from native input leaves the unspent wrapped remainder in the router
    if (inputIsNative && trade.tradeType === TradeType.EXACT_OUTPUT) {
      planner.addCommand(CommandType.UNWRAP_WETH, [SENDER_AS_RECIPIENT, 0])
    }

    const calldata =
      options.deadline !== undefined
        ? SwapRouter.INTERFACE.encodeFunctionData('execute(bytes,bytes[],uint256)', [
            planner.commands,
            planner.inputs,
            options.deadline
          ])
        : SwapRouter.INTERFACE.encodeFunctionData('execute(bytes,bytes[])', [planner.commands, planner.inputs])

    return {
      calldata,
      value: inputIsNative ? BigNumber.from(maximumAmountIn.quotient.toString()).toHexString() : '0x00'
    }
  }

  private static addSwap(
    planner: RoutePlanner,
    trade: Trade<Currency, Currency, TradeType>,
    swap: Swap<Currency, Currency>,
    options: SwapOptions,
    recipient: string,
    routerMustCustody: boolean,
    payerIsUser: boolean
  ): void {
    const exactInput = trade.tradeType === TradeType.EXACT_INPUT
    // when the router keeps custody the sweep enforces the limit for the whole trade
    const amountOutMinimum = routerMustCustody
      ? '0'
      : trade.minimumAmountOut(options.slippageTolerance, swap.outputAmount).quotient.toString()
    const amountInMaximum = trade
      .maximumAmountIn(options.slippageTolerance, swap.inputAmount)
      .quotient.toString()

    const route = swap.route
    if (route.protocol === Protocol.MIXED) {
      invariant(exactInput, 'MIXED_EXACT_OUTPUT_UNSUPPORTED')
      SwapRouter.addMixedSwap(
        planner,
        route as MixedRoute<Currency, Currency>,
        swap.inputAmount.quotient.toString(),
        amountOutMinimum,
        recipient,
        payerIsUser
      )
      return
    }

    if (route.protocol === Protocol.V2) {
      const routes = SwapRouter.v2Routes(route.pools as V2Pool[], routePath(route))
      planner.addCommand(exactInput ? CommandType.V2_SWAP_EXACT_IN : CommandType.V2_SWAP_EXACT_OUT, [
        recipient,
        exactInput ? swap.inputAmount.quotient.toString() : swap.outputAmount.quotient.toString(),
        exactInput ? amountOutMinimum : amountInMaximum,
        routes,
        payerIsUser
      ])
      return
    }

    const clRoute = route as CLRoute<Currency, Currency>
    planner.addCommand(exactInput ? CommandType.V3_SWAP_EXACT_IN : CommandType.V3_SWAP_EXACT_OUT, [
      recipient,
      exactInput ? swap.inputAmount.quotient.toString() : swap.outputAmount.quotient.toString(),
      exactInput ? amountOutMinimum : amountInMaximum,
      encodeRouteToPath(clRoute, !exactInput),
      payerIsUser
    ])
  }

  /**
   * A mixed route becomes one command per protocol run. Every section but the last hands its
   * output to the router, and every section but the first spends the router's balance.
   */
  private static addMixedSwap(
    planner: RoutePlanner,
    route: MixedRoute<Currency, Currency>,
    amountIn: string,
    amountOutMinimum: string,
    recipient: string,
    payerIsUser: boolean
  ): void {
    const sections = partitionMixedRouteByProtocol(route)
    let poolIndex = 0

    for (const [sectionIndex, section] of sections.entries()) {
      const isFirst = sectionIndex === 0
      const isLast = sectionIndex === sections.length - 1
      const tokens = route.path.slice(poolIndex, poolIndex + section.length + 1)

      const sectionRecipient = isLast ? recipient : ROUTER_AS_RECIPIENT
      const sectionAmountIn = isFirst ? amountIn : CONTRACT_BALANCE.toString()
      const sectionAmountOutMinimum = isLast ? amountOutMinimum : '0'
      const sectionPayerIsUser = isFirst ? payerIsUser : false

      if (isCLPool(section[0])) {
        planner.addCommand(CommandType.V3_SWAP_EXACT_IN, [
          sectionRecipient,
          sectionAmountIn,
          sectionAmountOutMinimum,
          SwapRouter.clPath(section as CLPool[], tokens),
          sectionPayerIsUser
        ])
      } else {
        planner.addCommand(CommandType.V2_SWAP_EXACT_IN, [
          sectionRecipient,
          sectionAmountIn,
          sectionAmountOutMinimum,
          SwapRouter.v2Routes(section as V2Pool[], tokens),
          sectionPayerIsUser
        ])
      }

      poolIndex += section.length
    }
  }

  private static v2Routes(pools: V2Pool[], tokens: Token[]): { from: string; to: string; stable: boolean }[] {
    invariant(tokens.length === pools.length + 1, 'V2_PATH_LENGTH')
    return pools.map((pool, i) => ({
      from: tokens[i].address,
      to: tokens[i + 1].address,
      stable: pool.stable
    }))
  }

  /** Slipstream paths put the tick spacing in the 3 byte slot Uniswap V3 uses for the fee */
  private static clPath(pools: CLPool[], tokens: Token[]): string {
    invariant(tokens.length === pools.length + 1, 'CL_PATH_LENGTH')
    const route = new CLRoute(pools, tokens[0], tokens[tokens.length - 1])
    return encodeRouteToPath(route, false)
  }
}

export type { AnyRoute, TPool }
export { CurrencyAmount }
