# @topazdex/routing-api

HTTP quote service over [`@topazdex/smart-order-router`](../smart-order-router). Given a pair and an
amount it returns the best route across Topaz CL and Topaz v2 pools, and — when a recipient is
supplied — the Universal Router calldata that executes it.

## Running

```bash
export BSC_MAINNET_RPC=https://…            # archive not required, but an unthrottled node helps
export UNIVERSAL_ROUTER_ADDRESS=0x…         # required only to return calldata
export PORT=3000
yarn workspace @topazdex/routing-api build
yarn workspace @topazdex/routing-api start
```

Integrating a frontend against this? Start with
[docs/FRONTEND_INTEGRATION.md](../../docs/FRONTEND_INTEGRATION.md), which covers approvals, Permit2
signing and execution end to end.

## `GET /quote` and `POST /quote`

`POST` takes the same fields as a JSON body, and is the only way to pass a Permit2 signature.


| parameter | required | description |
| --- | --- | --- |
| `tokenIn` | yes | address, or `BNB` / `native` for native BNB |
| `tokenOut` | yes | address, or `BNB` / `native` |
| `amount` | yes | integer in the smallest unit of the specified token |
| `type` | no | `exactIn` (default) or `exactOut` |
| `recipient` | no | supplying it returns executable `methodParameters` |
| `slippageBips` | no | default 50 (0.5%) |
| `permit` | no | a signed Permit2 `PermitSingle`, POST only |
| `deadlineSeconds` | no | default 1800 |
| `maxHops`, `maxSplits`, `distributionPercent`, `includeMixedRoutes` | no | routing knobs, see the SOR README |

```bash
curl 'localhost:3000/quote?tokenIn=BNB&tokenOut=0x55d398326f99059fF775485246999027B3197955&amount=1000000000000000000&type=exactIn&recipient=0xYourAddress'
```

```jsonc
{
  "blockNumber": 116350000,
  "tradeType": "exactIn",
  "amount": "1000000000000000000",
  "quote": "612340000000000000000",
  "quoteDecimals": "612.34",
  "quoteGasAdjusted": "612100000000000000000",
  "gasUseEstimate": "260000",
  "gasUseEstimateQuote": "240000000000000000",
  "routes": [
    {
      "protocol": "CL",
      "percent": 75,
      "amountIn": "750000000000000000",
      "amountOut": "459000000000000000000",
      "hops": [
        { "protocol": "cl", "address": "0x767F…", "tokenIn": "0xbb4C…", "tokenOut": "0x55d3…", "fee": 500, "tickSpacing": 50 }
      ]
    },
    { "protocol": "V2", "percent": 25, "…": "…" }
  ],
  "methodParameters": { "calldata": "0x3593564c…", "value": "0x0de0b6b3a7640000", "to": "0x…" }
}
```

`quote` is the output for `exactIn` and the input for `exactOut`. `quoteGasAdjusted` is the number
to compare offers on, since it nets out what the route costs to execute.

Errors: `400` for a malformed request or an unresolvable token, `404` when no route exists, `500`
otherwise.

## `GET /health`

```json
{ "status": "ok", "chainId": 56 }
```

## Behaviour

- **CORS** — allowlisted origins only, echoed rather than `*`. Defaults cover any loopback port and
  the topazdex hosts; `CORS_ORIGINS` overrides, where the literal `localhost` means any loopback
  port. Requested headers are reflected, since the API accepts no credentials.
- **Caching** — identical quotes are reused for 1s, about one BNB Chain block, and identical requests
  in flight are coalesced. `Cache-Control: no-cache` or `skipCache=true` forces a recompute, skipping
  both the stored value and anything in flight. Responses carry `X-Cache: HIT|MISS` and `Age`.
  Requests carrying a Permit2 signature and failed computations are never cached.
- **RPC** — several endpoints with failover, defaulting to a probed public list, so the service runs
  with no RPC configured.

## Deploying

See [docs/ROUTING_API_DEPLOYMENT.md](../../docs/ROUTING_API_DEPLOYMENT.md). There is a Dockerfile in
this package; build it from the repo root, since it needs the whole workspace as context.

```bash
docker build -f packages/routing-api/Dockerfile -t topazdex/routing-api .
```

## Tests

`src/server.test.ts` runs the service against an anvil fork of BNB Chain with the Universal Router
deployed, and executes the calldata the API hands back.

```bash
yarn workspace @topazdex/routing-api test
```
