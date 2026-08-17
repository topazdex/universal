# @topazdex/smart-order-router

Finds the best way to trade between two currencies across both Topaz stacks, and hands back
Universal Router calldata that executes it.

## Pipeline

```
subgraphs ─► candidate pools ─► live pool state ─► route enumeration ─► on-chain quotes
                                                                            │
                                            best split search ◄── gas adjusted quotes
                                                     │
                                          Trade ─► Universal Router calldata
```

1. **Discovery** — the v2 and v3 subgraphs rank pools by liquidity. They decide which pools are
   worth considering; they are never used to price anything.
2. **State** — every candidate pool is read on chain in one multicall: reserves and fee for v2,
   `slot0`/`liquidity`/`getSwapFee` for CL. Fees are read rather than assumed, because a v2 pool can
   carry a custom fee and a CL pool can be driven by a dynamic fee module.
3. **Routes** — a depth-first walk enumerates paths up to `maxHops`, sorted into pure v2, pure CL
   and mixed routes. A path may not use a pool twice.
4. **Quotes** — every route is priced at every split size by Topaz's own deployed quoters.
   `MixedRouteQuoterV1` handles all exact-input routes, since its path encoding treats a v2 hop as a
   flagged tick spacing. Exact output has no mixed quoter, so CL routes go through `QuoterV2` and
   volatile v2 routes are inverted locally; stable pools and mixed routes are excluded from exact
   output entirely, matching what the contracts can actually do.
5. **Gas** — each quote is adjusted by what that route costs to execute, converted into the quote
   token through the deepest BNB pool available.
6. **Split search** — a breadth-first search over percentage allocations, after Uniswap's alpha
   router: seed with the best single route, extend with the best complementary allocation that does
   not re-use a pool, keep the best gas-adjusted total.

## Usage

```ts
import { JsonRpcProvider } from '@ethersproject/providers'
import { CurrencyAmount, Percent, TradeType, USDT, BNB } from '@topazdex/sdk-core'
import { TopazRouter } from '@topazdex/smart-order-router'

const router = new TopazRouter({
  provider: new JsonRpcProvider(process.env.BSC_MAINNET_RPC, 56),
  universalRouterAddress: '0x…' // only needed for calldata
})

const route = await router.route(
  CurrencyAmount.fromRawAmount(BNB.onChain(56), '1000000000000000000'),
  USDT,
  TradeType.EXACT_INPUT,
  { slippageTolerance: new Percent(50, 10_000), recipient, deadline }
)

route.quote.toExact()        // output amount
route.quoteGasAdjusted       // the number to compare routes on
route.methodParameters       // { calldata, value, to }
```

## Tuning

| option | default | effect |
| --- | --- | --- |
| `distributionPercent` | 5 | split granularity; 5 means 20 quotes per route |
| `maxSplits` | 3 | most routes one trade may be split across |
| `maxHops` | 3 | longest path considered |
| `maxRoutesPerProtocol` | 60 | cap on enumerated routes, bounds quoting cost |
| `includeMixedRoutes` | true | allow routes that cross both stacks |
| `subgraphPoolCount` | 500 | pools pulled from each subgraph before filtering |

Quote count is `routes × (100 / distributionPercent)`, and each quote simulates a real swap, so
these two knobs dominate latency. Raise `distributionPercent` to 25 for a fast approximate quote.

## Tests

`src/mainnet.test.ts` routes real sizes against live liquidity on an anvil fork, then executes the
router's own calldata and checks the received amount lands within a basis point of the quote.

```bash
yarn workspace @topazdex/smart-order-router test
```
