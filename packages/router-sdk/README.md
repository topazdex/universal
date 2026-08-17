# @topazdex/router-sdk

Routes and trades that span both Topaz stacks.

## Mixed routes

A mixed route crosses Topaz CL and Topaz v2 pools in a single path, e.g. `WBNB —CL(50)→ USDT
—v2 stable→ USDC`. Topaz's deployed `MixedRouteQuoterV1` prices these, and it reuses the CL path
layout — `token ‖ uint24 ‖ token ‖ …` — putting a flag in the 3 byte pool slot for v2 hops:

| slot value | hop |
| --- | --- |
| `0x400000` (`1 << 22`) | Topaz v2 volatile pool |
| `0x200000` (`1 << 21`) | Topaz v2 stable pool |
| anything else | Topaz CL pool with that tick spacing |

`encodeMixedRouteToPath` emits exactly that. The mixed quoter is **exact input only**; there is no
mixed exact-output quoter, and stable pools cannot serve exact output at all.

`partitionMixedRouteByProtocol` splits a mixed route into the longest runs of one stack, which is
what the Universal Router executes: one command per run, with the router holding the intermediate
token.

## Trades

`Trade` aggregates one or more `Swap`s — each a route plus its input and output amount — so a trade
can be split across several routes and both stacks at once. It aggregates and applies slippage; it
does not price. Amounts come from whoever quoted the routes, which for the smart order router means
Topaz's on-chain quoters rather than a local simulation.

```ts
const trade = new Trade({
  swaps: [
    { route: clRoute, inputAmount: seventyFivePercent, outputAmount: clQuote },
    { route: v2Route, inputAmount: twentyFivePercent, outputAmount: v2Quote }
  ],
  tradeType: TradeType.EXACT_INPUT
})

trade.spansBothStacks          // true
trade.minimumAmountOut(slippage)
```

## Tests

`src/mainnet.test.ts` prices mixed routes through the live `MixedRouteQuoterV1` and requires the
result to equal the same route priced leg by leg — the CL leg by the CL quoter, the v2 leg by
`@topazdex/v2-sdk`'s Solidly math.
