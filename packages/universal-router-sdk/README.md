# @topaz/universal-router-sdk

Turns a `@topaz/router-sdk` trade into Universal Router calldata.

```ts
import { SwapRouter } from '@topaz/universal-router-sdk'

const { calldata, value } = SwapRouter.swapCallParameters(trade, {
  slippageTolerance: new Percent(50, 10_000),
  recipient,
  deadline,
  fee: { fee: new Percent(25, 10_000), recipient: feeCollector } // optional interface fee
})
```

## How a trade becomes commands

- **v2 hops** are encoded as a `Route[]` of `(from, to, stable)`, since a Topaz v2 pool is keyed by
  its stable flag.
- **CL hops** are encoded as a packed path carrying tick spacings.
- **Mixed routes** become one command per protocol run: every run but the last sends its output to
  the router (`ADDRESS_THIS`), and every run but the first spends the router's balance
  (`CONTRACT_BALANCE`) with `payerIsUser = false`.
- **Split trades** emit one command per route.
- **Native BNB in** prepends `WRAP_ETH` for the maximum input and pays the swaps from the router.
- **Native BNB out** routes the swaps into the router and appends `UNWRAP_WETH` to the recipient.
- **Interface fees** append `PAY_PORTION` then `SWEEP`, and the swept minimum is reduced by the fee
  so slippage checks stay honest.
- **Exact output from native input** appends `UNWRAP_WETH` to the sender, refunding the unspent
  slippage buffer.

Whenever the router must hold funds — native output, a fee, a split, or `safeMode` — the individual
swap commands carry a minimum of zero and the final sweep enforces the trade's slippage limit for
the whole trade at once.

## Tests

`src/mainnet.test.ts` deploys the Universal Router onto an anvil fork of BNB Chain and executes the
generated calldata against live Topaz pools: CL, v2, mixed, split, fee-taking, Permit2, native in
and out, exact output with refund, and an expired deadline.

Those tests fund a wallet derived from a repo-private key rather than anvil's default accounts —
the default keys are public, and their addresses carry an EIP-7702 delegation on BSC that forwards
any BNB they receive to a sweeper, which silently zeroes out native-output assertions.
