# Deploying the routing API

The service is stateless: it holds a pool-list cache in memory and nothing else. Scale it
horizontally, restart it freely, and point it at a good RPC — that last part is what determines
whether it is fast or useless.

## 1. Prerequisites

| what | why |
| --- | --- |
| **A BNB Chain RPC** | A quote is ~15-35 `eth_call`s run 16 at a time: **0.3-0.6s on a paid endpoint, 0.7-2.6s on the public list**. The service falls back to a built-in public list if you give it nothing, so public-only deployment is viable. |
| Node 22 | matches CI and the Docker image |
| The Universal Router address | already recorded in `@topazdex/universal-router-sdk`; only override it for a fork |

Latency is dominated by RPC round trips, so co-locate the service with the RPC provider's region.

## 2. Configuration

| variable | required | default | notes |
| --- | --- | --- | --- |
| `BSC_MAINNET_RPC` | no | public list | a single endpoint; archive access is *not* needed, throughput is |
| `BSC_RPC_URLS` | no | public list | comma separated, failover in order; takes precedence over `BSC_MAINNET_RPC` |
| `PORT` | no | `3000` | |
| `CHAIN_ID` | no | `56` | |
| `UNIVERSAL_ROUTER_ADDRESS` | no | recorded deployment | overrides the address used for calldata |
| `MULTICALL_BATCH_SIZE` | no | `15` | quote calls per `eth_call`; see the tuning section before changing it |
| `MULTICALL_CONCURRENCY` | no | `16` | `eth_call`s in flight; lower it if the RPC rate limits you |
| `ROUTING_BASE_TOKENS` | no | `BASE_TOKENS` | comma separated addresses the router may hop through |

No secrets beyond the RPC URL. If your RPC key is in the URL, treat the whole variable as a secret.

### RPC failover

Give it several endpoints and it fails over between them:

```bash
BSC_RPC_URLS="https://your-paid-endpoint,https://bsc-dataseed1.defibit.io,https://bsc-rpc.publicnode.com"
```

Requests go to the first healthy endpoint; one that fails at the transport level is skipped for 30
seconds. Two details make this safe rather than merely redundant:

- **A revert is not retried elsewhere.** It would come back identically from every endpoint, and
  retrying it just delays the caller's own handling of it.
- **The block height used is the lowest the endpoints agree on.** Quotes pin every call to one
  block, and endpoints lag each other by a block or two, so pinning to the fastest endpoint's head
  would make every call fail on the ones still catching up.

The built-in public list, used when nothing is configured:

| endpoint | notes |
| --- | --- |
| `bsc-dataseed1.defibit.io` | |
| `bsc-dataseed2.bnbchain.org` | |
| `bsc-rpc.publicnode.com` | |
| `bsc-dataseed1.bnbchain.org` | |
| `bsc-dataseed1.ninicoin.io` | |
| `bsc.blockrazor.xyz` | |
| `bsc-dataseed.bnbchain.org` | |
| `bsc.drpc.org` | slowest of the set under load |

Each was probed for the three things the router needs: the right chain, a `blockTag` a few blocks
back, and a Multicall3 batch of at least 200 quote simulations. `llamarpc`, `1rpc.io`,
`rpc.ankr.com`, `nodies`, `subquery` and `meowrpc` failed one of those and are deliberately
excluded.

## 3. Run it

### Fly.io

`fly.toml` at the repo root is ready to go. Deploy from the repo root — the Dockerfile needs the
whole workspace as build context.

```bash
fly launch --no-deploy --copy-config          # first time only, creates the app
fly secrets set BSC_MAINNET_RPC="https://…"   # the only secret
fly deploy
fly logs
```

Then:

```bash
curl -s https://topaz-routing-api.fly.dev/health
```

Choices baked into `fly.toml`, and when to change them:

| setting | value | why |
| --- | --- | --- |
| `primary_region` | `sin` | put the app near **your RPC provider**, not near your users — a quote is ~50 sequential-ish round trips to the RPC and one to the client |
| `auto_stop_machines` | `off` | a cold start costs seconds on top of an already multi-second quote |
| `min_machines_running` | 1 | same reason |
| `concurrency.soft_limit` | 15 | a quote holds the request open while waiting on the RPC, so a machine saturates at a low request count |
| `[[vm]] size` | `shared-cpu-2x`, 1GB | the work is IO bound; memory is for the pool cache |

Scale out rather than up: `fly scale count 2 --region sin`. Watch your RPC provider's rate limit
before adding machines — each one multiplies RPC load.

### Docker (recommended for other hosts)

```bash
# from the repo root, the Dockerfile expects the workspace as context
docker build -f packages/routing-api/Dockerfile -t topazdex/routing-api:latest .

docker run -d --name routing-api -p 3000:3000 \
  -e BSC_MAINNET_RPC="https://…" \
  --restart unless-stopped \
  topazdex/routing-api:latest
```

### Directly

```bash
yarn install --immutable
yarn build
BSC_MAINNET_RPC="https://…" PORT=3000 yarn workspace @topazdex/routing-api start
```

Behind a process manager:

```bash
pm2 start "yarn workspace @topazdex/routing-api start" --name routing-api
```

### systemd

```ini
[Unit]
Description=Topaz routing API
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/srv/topazdex-universal
Environment=NODE_ENV=production
EnvironmentFile=/etc/topazdex/routing-api.env
ExecStart=/usr/bin/node packages/routing-api/dist/server.js
Restart=always
RestartSec=5
User=topaz

[Install]
WantedBy=multi-user.target
```

## 4. Smoke test

```bash
curl -s localhost:3000/health
# {"status":"ok","chainId":56}

curl -s 'localhost:3000/quote?tokenIn=BNB&tokenOut=0x55d398326f99059fF775485246999027B3197955&amount=100000000000000000' \
  | jq '{quote: .quoteDecimals, routes: [.routes[] | {percent, protocol}]}'
```

Then prove a quote is executable before pointing a frontend at it — take the `methodParameters`
from a quote that includes a `recipient` and simulate it:

```bash
cast call <to> <calldata> --value <value> --from <recipient> --rpc-url $BSC_MAINNET_RPC
```

## 5. Put it behind a reverse proxy

The service has no TLS, no auth and no rate limiting. Terminate TLS and rate limit upstream:

```nginx
location /quote {
    limit_req zone=quotes burst=20 nodelay;
    proxy_pass http://127.0.0.1:3000;
    proxy_read_timeout 60s;   # a default quote takes a few seconds, more on a busy RPC
}
```

`limit_req_zone $binary_remote_addr zone=quotes:10m rate=5r/s;` in the `http` block is a sane start.
Without a limit, one client can saturate your RPC quota: each quote is ~15-35 `eth_call`s, and the
service issues 16 of them concurrently.

## 6. What to watch

| signal | why it matters |
| --- | --- |
| p95 latency on `/quote` | dominated by RPC round trips; a jump means the RPC is degrading |
| RPC requests per quote | ~15-35 for a default quote; a big rise means batches are being split, i.e. the node is rejecting them on gas |
| rate of `404 No route found` | a spike usually means the subgraph is stale or the RPC is failing calls |
| `5xx` | RPC errors surface here |
| RPC call volume | quote calls ≈ `routes × (100 / distributionPercent)`, batched 15 per `eth_call`, so this scales with traffic and with routing config |

## 7. Multicall batch size

The defaults are measured, not guessed. A 5 BNB quote before route screening was added, batches run
16 at a time — screening cut the call counts 3-4x since, but the shape of the curve is unchanged:

| batch | paid RPC | public RPC | `eth_call`s | batches split |
| --- | --- | --- | --- | --- |
| 5 | 1.60s | — | 291 | 0 |
| 10 | 1.60s | 7.8s | 146 | 0 |
| **15** | **1.25s** | **5.4s** | **98** | **0** |
| 20 | 2.09s | — | 81 | 4 |
| 25 | — | 8.2s | 67 | 4 |
| 40 | 3.70s | 10.8s | 49 | 6 |
| 200 | 6.36s | — | 43 | 17 |

Bigger batches mean fewer requests, and are *slower*. Past ~15 quote simulations a batch overruns
the node's `eth_call` gas ceiling; it is then halved and retried, so it costs two round trips and a
wasted simulation instead of one. 15 was the largest split-free size on both a paid endpoint and a
public dataseed node, and it was fastest on both.

Concurrency, at batch 15 on the paid endpoint: 8 → 2.12s, 16 → 1.44s, 24 → 1.34s, 32 → 1.14s.
Returns flatten after 16, and higher values burn provider quota in bursts, so 16 is the default.

Pool state reads batch at 60, separately: they are plain view calls costing a few thousand gas, so
the ceiling that constrains quotes does not apply.

Lower `MULTICALL_BATCH_SIZE` if you see splits in your logs; lower `MULTICALL_CONCURRENCY` if your
provider rate limits you.

## 8. Hops, intermediaries, and what they cost

`maxHops` defaults to **3**, over the intermediary tokens in `BASE_TOKENS`. Routes enumerated for
BNB → TOPAZ, which sets how much quoting there is to do:

| intermediaries | 2 hops | 3 hops | 4 hops |
| --- | --- | --- | --- |
| 6 (default) | 7 | 33 | 137 |
| 8 | 7 | 43 | 219 |
| 10 | 7 | 53 | 261 |
| 12 | 7 | 53 | 261 |

Hop depth dominates: each extra hop multiplies routes by roughly 4x. Each extra intermediary adds
about 5 routes at 3 hops, and stops mattering once the token has no more pools to reach — the 10 and
12 rows are identical because the last two tokens added no new pools.

### Where the intermediary list lives

Three places, in order of how permanent the change is:

1. `BASE_TOKENS` in [`packages/sdk-core/src/index.ts`](../packages/sdk-core/src/index.ts) — the default.
2. `ROUTING_BASE_TOKENS` — a comma separated list of addresses, overrides the default per deployment.
3. `baseTokens` on `RoutingConfig` — per call, for programmatic use.

A token earns a place by *connecting* pairs, not by being popular: it needs live pools with more
than one counterparty, otherwise it can only ever be an endpoint. Tokens outside the list are still
reachable — the router adds the counterparties of the deepest pools holding either side of the
trade, so a long-tail token is picked up when it is actually relevant.

That auto-discovery is why widening the list changes less than you would expect. Measured on ten
pairs, including spoke-to-spoke ones like SOL → XRP and BOOK → TOPAZ, going from 6 hubs to 10
returned **identical quotes** for +0 to +7 `eth_call`s. The list matters as Topaz liquidity grows a
denser middle; today most paths run through WBNB or USDT regardless.

**Adding intermediaries is cheap now.** Routes are screened before the expensive pass (see below),
so an extra intermediary costs about 2 quote calls per route it adds, not 20. Going from 6 to 10
intermediaries on a BNB → TOPAZ quote is roughly 10 extra `eth_call`s.

### Why routes are screened

Quoting is the entire cost of routing: quote calls are `routes × (100 / distributionPercent)`, so 33
routes at 5% granularity is 660 swap simulations. Instead, every route is priced at just its
smallest and largest slice, and only the best survivors are priced across every slice. The screening
quotes are reused, so survivors cost nothing extra.

Measured on five pairs against a full sweep that prices every route: **identical quotes to the wei,
3-4x fewer RPC calls.** The screen keeps a quarter of the routes found, between 8 and 32, which is
why raising `maxHops` still converges on the same answer.

If you raise `maxHops` past 4 or add many intermediaries, watch that `maxRoutesToQuote` grows with
it — a screen that is too narrow for the search will quietly return a worse quote.

## 9. Tuning cost against quality

Per-request knobs, all query parameters:

```
?distributionPercent=25   # 4 buckets instead of 20 — far fewer RPC calls, coarser splits
&maxSplits=2
&maxHops=2
&includeMixedRoutes=false
```

`maxRoutesToQuote` is also accepted, for widening the screen when searching deeper.

For a price display, `distributionPercent=25` is usually indistinguishable and much cheaper. For an
actual swap, leave the defaults: on a 5 BNB → TOPAZ trade, the default 5% granularity beat the best
single route by 1.4%, which dwarfs any gas saving from a simpler route.

## 10. Known gaps before heavy production traffic

- **No pool-state cache.** Every quote re-reads pool state from the chain. A cache keyed by block
  number would cut RPC load dramatically for repeated pairs — the single biggest remaining win.
- **The subgraph pool list is cached for 5 minutes** (`subgraphCacheTtlMs`), and a brand new pool is
  invisible until that refresh. Quotes are never wrong because of it — pool state always comes from
  the chain — but a fresh pool can be missed.
- **No request coalescing.** Identical concurrent quotes each do their own work.
- **No auth or per-key quotas.** Fine behind an internal proxy; not fine exposed directly.
