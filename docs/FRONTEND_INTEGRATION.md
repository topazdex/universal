# Frontend integration

How to get a quote from the Topaz routing API and execute it through the Topaz Universal Router.

The service does the routing, the pricing and the calldata encoding. The frontend does three things:
ask for a quote, make sure the router can pull the input token, and send one transaction.

```
  user picks tokens + amount
            │
            ▼
  GET/POST  quote.topazdex.com/quote      ← route search, on-chain quoting, calldata
            │
            ├─ input is native BNB?  ──────────────► nothing to approve
            └─ input is an ERC20?    ──────────────► Permit2 signature (or a one-off approval)
            │
            ▼
  wallet sends { to, data, value } ─────────────────► UniversalRouter
```

## Addresses

| what | address |
| --- | --- |
| Universal Router | `0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Routing API | `https://quote.topazdex.com` |
| Chain | BNB Chain mainnet, `56` |

Never hardcode the router in the frontend: use the `to` field the API returns. It is the same
address, but taking it from the response means a redeploy does not need a frontend release.

---

## 1. Getting a quote

`GET /quote` for everything except a Permit2 signature; `POST /quote` with a JSON body when you have
one (a signature is 132 characters and does not belong in a URL). The parameters are identical.

### Parameters

| name | required | default | meaning |
| --- | --- | --- | --- |
| `tokenIn` | yes | | token address, or `BNB` / `native` / the zero address for native BNB |
| `tokenOut` | yes | | same |
| `amount` | yes | | **integer, in the token's smallest unit.** For `exactIn` it is the input amount; for `exactOut` the output amount |
| `type` | no | `exactIn` | `exactIn` or `exactOut` |
| `recipient` | no | | who receives the output. **Omit it and you get a price only — no `methodParameters`** |
| `slippageBips` | no | `50` | 50 = 0.50%. Bounds the limit written into the calldata |
| `deadlineSeconds` | no | `1800` | seconds from now until the transaction expires |
| `permit` | no | | a signed Permit2 allowance, POST only. See §2 |
| `maxHops` | no | `3` | pools per route |
| `maxSplits` | no | `3` | routes the trade may be split across |
| `distributionPercent` | no | `5` | split granularity; 25 is faster and coarser |
| `includeMixedRoutes` | no | `true` | allow a single route to cross CL and v2 |

Two request shapes, so a price display never asks for calldata it will not use:

```ts
// price only, no wallet connected
const priceUrl = `https://quote.topazdex.com/quote?tokenIn=BNB&tokenOut=${USDT}&amount=${amountIn}`

// executable, wallet connected
const swapUrl = `${priceUrl}&recipient=${account}&slippageBips=50`
```

### Response

```jsonc
{
  "blockNumber": 116406800,          // the block every pool was read at
  "tradeType": "exactIn",
  "amount": "1000000000000000000",   // what you asked for, echoed
  "quote": "606591038085730308481",  // exactIn: output. exactOut: input required
  "quoteDecimals": "606.591038085730308481",
  "quoteGasAdjusted": "606582260289771652705",
  "slippageBips": 50,
  "minimumAmountOut": "603573172224607272120",  // exactIn only
  // "maximumAmountIn": "…",                    // exactOut only
  "gasUseEstimate": "290000",
  "gasUseEstimateQuote": "8777795958655775",    // that gas, priced in the quote token
  "routes": [
    {
      "protocol": "CL",              // CL | V2 | MIXED
      "percent": 100,                // share of the trade on this route
      "amountIn": "1000000000000000000",
      "amountOut": "606591038085730308481",
      "hops": [
        {
          "protocol": "cl",          // cl | v2-volatile | v2-stable
          "address": "0x767F1F4bF9E5E40F3D865c172c9bD0AE216e65B4",
          "tokenIn": "0xbb4C…",
          "tokenOut": "0x55d3…",
          "fee": 112,                // CL: pips (1e-6). v2: basis points (30 = 0.30%)
          "tickSpacing": 50          // CL only
        }
      ]
    }
  ],
  "methodParameters": {              // present only when `recipient` was supplied
    "calldata": "0x3593564c…",
    "value": "0x0de0b6b3a7640000",   // native BNB to send; "0x00" for ERC20 input
    "to": "0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6"
  }
}
```

Which numbers belong in the UI:

| field | use |
| --- | --- |
| `quote` | the headline "you receive" (or "you pay" for `exactOut`) |
| `minimumAmountOut` / `maximumAmountIn` | the "at least" / "at most" line. **Do not recompute this from `quote` and slippage** — it comes from the same trade the calldata was built from, so it always agrees with what the chain will enforce |
| `quoteGasAdjusted` | for comparing routes, not for display. `quote` minus the route's gas cost, in the quote token |
| `gasUseEstimate` | gas to show, and a sane `gasLimit` starting point |
| `routes[].hops` | the route diagram; `percent` gives the split weights |

Price impact is not returned. If you show it, compute it against your own spot price source, since
the API deliberately has no opinion about USD value.

### Errors

| status | when |
| --- | --- |
| `400` | bad parameters, unresolvable token, malformed permit. `{"error": "..."}` says which |
| `404` | `{"error":"No route found"}` — no path with liquidity |
| `500` | RPC or internal failure. Retry once; the RPC pool fails over on its own |

---

## 2. Making sure the router can pull the input

Native BNB needs nothing — it rides along as `value`. For an ERC20 input there are two options.

### Permit2 (recommended)

One on-chain approval per token, ever, and then a signature per swap. This is what the Topaz
interface already knows how to do — it uses `@uniswap/permit2-sdk` and signs a `PermitSingle`.

**Step 1 — approve Permit2 once per token** (skip if `allowance(user, PERMIT2) > 0`):

```ts
await writeContract({
  address: tokenIn,
  abi: erc20Abi,
  functionName: 'approve',
  args: [PERMIT2_ADDRESS, maxUint256],
})
```

**Step 2 — read the current Permit2 allowance** to get the nonce, and to know whether a signature is
even needed:

```ts
const [amount, expiration, nonce] = await readContract({
  address: PERMIT2_ADDRESS,
  abi: [{
    name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }],
  }],
  functionName: 'allowance',
  args: [account, tokenIn, router],   // router = the `to` from the quote
})

const needsPermit = amount < amountIn || expiration < nowInSeconds
```

**Step 3 — sign a `PermitSingle`** when needed. The exact EIP-712 payload:

```ts
const permit = {
  details: {
    token: tokenIn,
    amount: (2n ** 160n - 1n).toString(),          // max, so one signature covers future swaps
    expiration: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
    nonce,                                          // from step 2
  },
  spender: router,
  sigDeadline: Math.floor(Date.now() / 1000) + 1800,
}

const signature = await signTypedData({
  domain: { name: 'Permit2', chainId: 56, verifyingContract: PERMIT2_ADDRESS },
  types: {
    PermitDetails: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
    PermitSingle: [
      { name: 'details', type: 'PermitDetails' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' },
    ],
  },
  primaryType: 'PermitSingle',
  message: permit,
})
```

The domain has **no `version` field** — adding one produces a different hash and the router will
revert.

**Step 4 — POST the quote with the permit.** The API folds it into the calldata as a
`PERMIT2_PERMIT` command ahead of the swap, so approval and swap land in one transaction:

```ts
const quote = await fetch('https://quote.topazdex.com/quote', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    tokenIn, tokenOut, amount, type: 'exactIn',
    recipient: account, slippageBips: 50,
    permit: { ...permit, signature },
  }),
}).then(r => r.json())
```

`permit.details.token` must be the input token and `permit.spender` must be the router, or the API
returns `400`.

### A plain approval instead

The router also accepts a direct ERC20 allowance to itself — it tries `transferFrom` first and only
falls back to Permit2. Simpler, but it costs an approval transaction per token and leaves a standing
allowance:

```ts
await writeContract({ address: tokenIn, abi: erc20Abi, functionName: 'approve', args: [router, amountIn] })
```

Use this only where signing is awkward. Everything else should use Permit2.

---

## 3. Sending the swap

```ts
const { to, calldata, value } = quote.methodParameters

const hash = await sendTransaction({
  to,
  data: calldata,
  value: BigInt(value),                 // "0x00" for ERC20 input
  gas: BigInt(quote.gasUseEstimate) * 130n / 100n,
})
```

Notes that matter:

- **`value` is a hex string.** Pass it through `BigInt()`; do not assume zero for ERC20 inputs.
- **Add headroom to `gasUseEstimate`.** It is a model, not a simulation; 20-30% is comfortable.
  Letting the wallet estimate is also fine.
- **The deadline is already inside the calldata.** It comes from `deadlineSeconds` at quote time, so
  a quote left sitting on screen eventually reverts with `TransactionDeadlinePassed` — that is the
  intended behaviour, not a bug to work around.

### Simulate before sending

A cheap way to catch a stale quote before the user signs:

```ts
await publicClient.call({ account, to, data: calldata, value: BigInt(value) })
```

A revert here almost always means the quote went stale — re-quote and retry.

---

## 4. CORS

Allowed origins: **any `localhost` or `127.0.0.1` port** over http, plus `https://app.topazdex.com`
and the apex and `www` hosts. Dev servers differ — Vite is 5173, Next is 3000 — and a browser treats
`http://127.0.0.1:3000` as a *different origin* from `http://localhost:3000`, so both spellings work.

Any request header you ask for is allowed; the preflight reflects it back. That matters for the
`Cache-Control: no-cache` refresh below, because `Cache-Control` is not CORS-safelisted and so
triggers a preflight of its own.

If a browser reports a CORS error, check in this order:

1. **The origin.** Open devtools → Network → the failed request → Request Headers → `Origin`. It must
   be loopback or a topazdex host. A tunnel (`ngrok`, `*.vercel.app` preview) is neither.
2. **Credentials.** The API never accepts them, so `credentials: 'include'` on your `fetch` will fail
   regardless of origin. Leave it unset.
3. **A non-2xx response.** A `400` or `404` still carries CORS headers, but the browser surfaces the
   body being unreadable as a CORS error. Check the status before blaming CORS.

For any other origin, `CORS_ORIGINS` is a deployment variable — ask rather than proxying around it.

## 5. Keeping quotes fresh

Every quote is computed at one block (`blockNumber`) and enforces `minimumAmountOut` on chain.

Identical requests are reused for **1 second**, roughly one BNB Chain block. That exists to collapse
duplicate renders and simultaneous callers, not to withhold data — so **an explicit refresh always
recomputes**:

```ts
fetch(url, { headers: { 'Cache-Control': 'no-cache' } })   // or add &skipCache=true
```

Use it when the user presses refresh, and before building the transaction they are about to sign.
Background polling should leave it off, so ten open tabs cost one computation rather than ten.

Every response says which it was:

| header | meaning |
| --- | --- |
| `X-Cache: MISS` | computed for this request |
| `X-Cache: HIT` | reused; `Age` gives its age in seconds |

Two consequences:

- **Re-quote on a timer.** Every 10-15 seconds while the swap screen is open is reasonable; BNB
  Chain produces a block every 0.75s.
- **Re-quote immediately before signing** if the displayed quote is older than a few seconds. If the
  price moved beyond slippage, the transaction reverts rather than filling badly.

With `@tanstack/react-query`, which the interface already uses:

```ts
useQuery({
  queryKey: ['quote', tokenIn, tokenOut, amount, type, account, slippageBips],
  queryFn: () => fetchQuote(...),
  refetchInterval: 12_000,
  staleTime: 10_000,
  enabled: Boolean(amount) && amount !== '0',
})
```

---

## 6. Behaviour worth knowing before you hit it

**Stable pools cannot serve exact output.** The Solidly stable curve has no closed-form inverse, so
the router excludes stable and mixed routes from `exactOut` searches. A stable-only pair quoted as
`exactOut` returns `404`. Quote it as `exactIn` instead.

**Exact output refunds the unspent input.** For `exactOut` from native BNB the calldata wraps
`maximumAmountIn`, swaps what it needs, and unwraps the remainder back to the sender in the same
transaction. The wallet's balance change is the true cost, which is less than `value`.

**Splits and mixed routes are one transaction.** A response with several `routes`, or a route whose
`hops` change protocol, is still a single `methodParameters`. Do not try to execute legs separately.

**The router holds no funds between transactions.** Every command sequence ends by paying out. There
is no state to manage, and nothing to rescue if a transaction reverts.

**Fee-on-transfer tokens are not modelled.** Quotes come from Topaz's quoters, which price the pool
maths and not a token's transfer hook. For a token that taxes transfers, the received amount will be
below `quote` and can breach `minimumAmountOut`. Raise slippage for those pairs or exclude them.

**Native versus wrapped is your choice.** Passing `BNB` makes the router wrap and unwrap for you;
passing the WBNB address treats it as a plain ERC20 and requires an allowance. Use whichever the
user's balance is in.

---

## 7. End to end, in the interface's stack

wagmi 2.x + viem 2.x + react-query, matching what `topaz-interface` already depends on:

```ts
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const API = 'https://quote.topazdex.com'

async function swap({ tokenIn, tokenOut, amountIn, account, slippageBips = 50 }) {
  const isNative = tokenIn === 'BNB'

  // 1. price it, and find out which router to permit
  const priced = await fetch(
    `${API}/quote?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amount=${amountIn}&recipient=${account}&slippageBips=${slippageBips}`
  ).then(r => r.json())
  if (priced.error) throw new Error(priced.error)

  const router = priced.methodParameters.to
  let body = { tokenIn, tokenOut, amount: amountIn, recipient: account, slippageBips }

  // 2. an ERC20 input needs Permit2: approve once, then sign per swap
  if (!isNative) {
    const allowance = await readContract({
      address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [account, PERMIT2],
    })
    if (allowance < BigInt(amountIn)) {
      const hash = await writeContract({
        address: tokenIn, abi: erc20Abi, functionName: 'approve', args: [PERMIT2, maxUint256],
      })
      await waitForTransactionReceipt({ hash })
    }

    const [permitted, expiration, nonce] = await readContract({
      address: PERMIT2, abi: permit2Abi, functionName: 'allowance', args: [account, tokenIn, router],
    })

    if (permitted < BigInt(amountIn) || expiration < Math.floor(Date.now() / 1000)) {
      const permit = {
        details: {
          token: tokenIn,
          amount: (2n ** 160n - 1n).toString(),
          expiration: Math.floor(Date.now() / 1000) + 2_592_000,
          nonce,
        },
        spender: router,
        sigDeadline: Math.floor(Date.now() / 1000) + 1800,
      }
      const signature = await signTypedData({ /* domain + types from §2 */ message: permit })
      body = { ...body, permit: { ...permit, signature } }
    }
  }

  // 3. re-quote with the permit, so the calldata is fresh and self-contained
  const quote = await fetch(`${API}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json())
  if (quote.error) throw new Error(quote.error)

  // 4. one transaction
  const { to, calldata, value } = quote.methodParameters
  return sendTransaction({
    to,
    data: calldata,
    value: BigInt(value),
    gas: (BigInt(quote.gasUseEstimate) * 130n) / 100n,
  })
}
```

The first call is deliberately cheap and gives you the router address and a price to display; the
second is made once the user commits, so the calldata is as fresh as possible.

---

## 8. If you would rather build calldata in the browser

The same encoding is available client-side, which is useful for custom flows the API does not model:

```ts
import { SwapRouter } from '@topazdex/universal-router-sdk'

const { calldata, value } = SwapRouter.swapCallParameters(trade, {
  slippageTolerance: new Percent(50, 10_000),
  recipient,
  deadline,
  inputTokenPermit: { ...permit, signature },
  fee: { fee: new Percent(25, 10_000), recipient: feeCollector },  // interface fee
})
```

That requires building the `Trade` yourself from `@topazdex/router-sdk`, which means quoting the
routes too. The API exists so you do not have to; reach for this only when you need something it
does not expose, such as an interface fee.

---

## Reference

- [Routing API deployment and tuning](ROUTING_API_DEPLOYMENT.md)
- [Router deployment and verification](DEPLOYMENT.md)
- [`@topazdex/universal-router`](../packages/universal-router/README.md) — the command set the calldata is built from
