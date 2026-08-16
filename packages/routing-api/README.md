# @topaz/routing-api

HTTP quote service over [`@topaz/smart-order-router`](../smart-order-router). Given a pair and an
amount it returns the best route across Topaz CL and Topaz v2 pools, and — when a recipient is
supplied — the Universal Router calldata that executes it.

## Running

```bash
export BSC_MAINNET_RPC=https://…            # archive not required, but an unthrottled node helps
export UNIVERSAL_ROUTER_ADDRESS=0x…         # required only to return calldata
export PORT=3000
yarn workspace @topaz/routing-api build
yarn workspace @topaz/routing-api start
```

## `GET /quote`

| parameter | required | description |
| --- | --- | --- |
| `tokenIn` | yes | address, or `BNB` / `native` for native BNB |
| `tokenOut` | yes | address, or `BNB` / `native` |
| `amount` | yes | integer in the smallest unit of the specified token |
| `type` | no | `exactIn` (default) or `exactOut` |
| `recipient` | no | supplying it returns executable `methodParameters` |
| `slippageBips` | no | default 50 (0.5%) |
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

## Tests

`src/server.test.ts` runs the service against an anvil fork of BNB Chain with the Universal Router
deployed, and executes the calldata the API hands back.

```bash
yarn workspace @topaz/routing-api test
```
