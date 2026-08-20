# @topazdex/smart-order-router

Finds the best way to trade between two currencies across both Topaz stacks, and hands back
Universal Router calldata that executes it.

## Pipeline

```
subgraphs ─► candidate pools ─► live pool state ─► route enumeration ─► on-chain quotes
                                                                            │
                                            best split search ◄──── token quotes
                                                     │
                                          Trade ─► Universal Router calldata
```

1. **Discovery** — the v2 and v3 subgraphs rank pools by liquidity. They decide which pools are
   worth considering; they are never used to price anything. Candidates are the traded pair, the
   hub tokens in `BASE_TOKENS`, and the counterparties of the deepest pools holding either traded
   token — which is how a token that is nobody's hub still gets routed through. Quoting 1 BNB → TQB
   finds `BNB → USDT → QQQB → TQB` and beats the two-hop path by 18%, with QQQB configured nowhere.
2. **State** — every candidate pool is read on chain in one multicall: reserves and fee for v2,
   `slot0`/`liquidity`/`getSwapFee` for CL. Fees are read rather than assumed, because a v2 pool can
   carry a custom fee and a CL pool can be driven by a dynamic fee module.
3. **Routes** — a depth-first walk enumerates paths up to `maxHops`, sorted into pure v2, pure CL
   and mixed routes. A path may not use a pool twice.
4. **Local ranking** — candidates are scored from pool state already in memory and only the best
   `maxRoutesToScreen` reach the chain, because on-chain quoting is 86% of a quote's wall clock. v2
   legs use the real Solidly maths; CL legs use virtual reserves (`L/√P`, `L·√P`), which price impact
   correctly inside the current tick range. The estimate ranks, it never answers.
5. **Screening** — surviving routes are priced on chain at their smallest and largest slice, and the
   best go on to the expensive pass. Both sizes matter: a deep pool wins the full amount while a thin
   one can still win a small slice. Measured against pricing every route, steps 4 and 5 together
   return identical quotes with 3-4x fewer RPC calls.
6. **Quotes** — surviving routes are priced at every split size by Topaz's own deployed quoters.
   `MixedRouteQuoterV1` handles all exact-input routes, since its path encoding treats a v2 hop as a
   flagged tick spacing. Exact output has no mixed quoter, so CL routes go through `QuoterV2` and
   volatile v2 routes are inverted locally; stable pools and mixed routes are excluded from exact
   output entirely, matching what the contracts can actually do.
7. **Gas** — each quote is adjusted by what that route costs to execute, converted into the quote
   token through the deepest BNB pool available.
8. **Split search** — a breadth-first search over percentage allocations, after Uniswap's alpha
   router: seed with the best single route, extend with the best complementary allocation that does
   not re-use a pool, keep the total with the best token output (or lowest token input). Gas is
   estimated and returned separately; it never makes a combined search lose to a pure route on the
   token amount the swap actually executes.

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

## RPC

Quoting is the whole cost of routing, so the provider matters. `FallbackRpcProvider` sends each
request to the first healthy endpoint, skips one that fails at the transport level for 30 seconds,
and reports the lowest block height its endpoints agree on — quotes pin every call to one block, and
endpoints lag each other, so pinning to the fastest one's head would break calls on the rest. A
revert is never retried elsewhere: it would come back identically everywhere.

```ts
import { FallbackRpcProvider, PUBLIC_BSC_RPC_URLS } from '@topazdex/smart-order-router'

const provider = new FallbackRpcProvider([process.env.PAID_RPC, ...PUBLIC_BSC_RPC_URLS])
```

`PUBLIC_BSC_RPC_URLS` is a probed list of public endpoints that serve historical block tags and
accept large Multicall3 batches. A paid endpoint is roughly 4x faster end to end.

## Tuning

| option | default | effect |
| --- | --- | --- |
| `distributionPercent` | 5 | split granularity; 5 means 20 quotes per route |
| `maxSplits` | 3 | most routes one trade may be split across |
| `maxHops` | 3 | longest path considered |
| `maxRoutesPerProtocol` | 60 | cap on enumerated routes, bounds quoting cost |
| `maxRoutesToQuote` | routes found / 4, 12..32 | routes carried from the screen into the full sweep |
| `maxRoutesToScreen` | 20 | candidates that survive local ranking and reach the chain |
| `discoveredIntermediariesPerToken` | 5 | deepest pools per traded token whose counterparty becomes routable |
| `includeMixedRoutes` | true | allow routes that cross both stacks |
| `subgraphPoolCount` | 500 | pools pulled from each subgraph before filtering |

`maxRoutesToQuote` is derived from how many routes were *found*, not how many survived local
ranking. Deriving it from the narrowed set once shrank the screen from 13 survivors to 5 and cost up
to 50 bips on trades that split three ways.

Quote count is `routes × (100 / distributionPercent)`, and each quote simulates a real swap, so
these two knobs dominate latency. Raise `distributionPercent` to 25 for a fast approximate quote.

Those quotes are batched through Multicall3, 15 per `eth_call` with 16 calls in flight. Both numbers
are measured rather than assumed: past ~15 simulations a batch overruns the node's `eth_call` gas
ceiling and has to be halved and retried, which costs more than the request it saved. See the
[routing API deployment guide](../../docs/ROUTING_API_DEPLOYMENT.md#7-multicall-batch-size) for the
full sweep.

## Tests

`src/mainnet.test.ts` routes real sizes against live liquidity on an anvil fork, then executes the
router's own calldata and checks the received amount lands within a basis point of the quote.

```bash
yarn workspace @topazdex/smart-order-router test
```
