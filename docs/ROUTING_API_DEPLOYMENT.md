# Deploying the routing API

The service is stateless: it holds a pool-list cache in memory and nothing else. Scale it
horizontally, restart it freely, and point it at a good RPC — that last part is what determines
whether it is fast or useless.

## 1. Prerequisites

| what | why |
| --- | --- |
| **An unthrottled BNB Chain RPC** | Every quote fires hundreds of `eth_call`s. A public dataseed node will rate-limit you into 30-second quotes. Use a paid Alchemy/QuickNode/Ankr endpoint, or your own node. |
| Node 22 | matches CI and the Docker image |
| The Universal Router address | already recorded in `@topazdex/universal-router-sdk`; only override it for a fork |

Latency is dominated by RPC round trips, so co-locate the service with the RPC provider's region.

## 2. Configuration

| variable | required | default | notes |
| --- | --- | --- | --- |
| `BSC_MAINNET_RPC` | yes | — | archive access is *not* needed; throughput is |
| `PORT` | no | `3000` | |
| `CHAIN_ID` | no | `56` | |
| `UNIVERSAL_ROUTER_ADDRESS` | no | recorded deployment | overrides the address used for calldata |

No secrets beyond the RPC URL. If your RPC key is in the URL, treat the whole variable as a secret.

## 3. Run it

### Docker (recommended)

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
    proxy_read_timeout 60s;   # a cold quote can take tens of seconds
}
```

`limit_req_zone $binary_remote_addr zone=quotes:10m rate=5r/s;` in the `http` block is a sane start.
Without a limit, one client can saturate your RPC quota, since each quote is hundreds of calls.

## 6. What to watch

| signal | why it matters |
| --- | --- |
| p95 latency on `/quote` | dominated by RPC round trips; a jump means the RPC is degrading |
| rate of `404 No route found` | a spike usually means the subgraph is stale or the RPC is failing calls |
| `5xx` | RPC errors surface here |
| RPC call volume | quotes ≈ `routes × (100 / distributionPercent)` calls, so this scales with traffic and with routing config |

## 7. Tuning cost against quality

Per-request knobs, all query parameters:

```
?distributionPercent=25   # 4 buckets instead of 20 — far fewer RPC calls, coarser splits
&maxSplits=2
&maxHops=2
&includeMixedRoutes=false
```

For a price display, `distributionPercent=25` is usually indistinguishable and much cheaper. For an
actual swap, leave the defaults: on a 5 BNB → TOPAZ trade, the default 5% granularity beat the best
single route by 1.4%, which dwarfs any gas saving from a simpler route.

## 8. Known gaps before heavy production traffic

- **No pool-state cache.** Every quote re-reads pool state from the chain. A cache keyed by block
  number would cut RPC load dramatically for repeated pairs.
- **The subgraph pool list is cached for 5 minutes** (`subgraphCacheTtlMs`), and a brand new pool is
  invisible until that refresh. Quotes are never wrong because of it — pool state always comes from
  the chain — but a fresh pool can be missed.
- **No request coalescing.** Identical concurrent quotes each do their own work.
- **No auth or per-key quotas.** Fine behind an internal proxy; not fine exposed directly.
