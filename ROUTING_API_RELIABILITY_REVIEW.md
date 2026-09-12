# Routing API: Fly deployment, performance, and reliability review

Reviewed: September 12, 2026. Application: `topaz-routing-api`.

This document records a read-only review of the routing API in this repository, its running Fly Machine, and normal quote requests on all four supported chains. The original review below records the pre-hardening deployment. **The September 12 hardening implementation is committed locally but not deployed; see [ROUTING_API_HARDENING.md](ROUTING_API_HARDENING.md).** No application code, deployment configuration, machine count, or production secrets were changed during the review.

The API already stays warm and can return ordinary quotes in under a second on some chains. The highest priorities are request validation, limits on expensive work, reliable RPC configuration, and a second warm instance. Increasing CPU alone would not address the main findings.

**Verified deployment and existing strengths**

| Item | Observed configuration |
| --- | --- |
| Public endpoint | `https://topaz-routing-api.fly.dev` |
| Running Machines | One; no additional stopped spare |
| Machine | `e820435f372648` |
| Region | Chicago, `ord` |
| Resources | Two shared CPUs, 1 GB RAM |
| Idle behavior | `auto_stop_machines = 'off'`; automatic starting enabled |
| Minimum running setting | One |
| Fly request concurrency | Soft limit 15; hard limit 30 |
| Health check | `GET /health`, every 30 seconds, five-second timeout |
| Restart policy | `on-failure`, maximum 10 retries |
| Chains | BNB 56, Robinhood 4663, Base 8453, Ethereum 1 |
| Fly secrets | None configured on the routing application |
| Quote response cache | One-second default TTL, 500 entries per chain, identical in-flight requests coalesced |
| Subgraph pool-list cache | Five minutes by default for BNB; 30 seconds for the three spokes |
| Multicall defaults | 15 inner calls per batch; up to 16 batches per invocation |

The running image was `registry.fly.io/topaz-routing-api:deployment-01M2A13S0B88AYKMDWVGW33XV7`. The production JSON configuration and the reviewed server, response-cache, quote-service, multicall, fallback-provider, router, and route-enumeration source files shipped in that image matched the working tree. This is not a claim that every file or compiled artifact was compared. The repository already had uncommitted work when the review began.

Existing strengths include enforced HTTPS, a non-root Node runtime, multicall batching, parallel reads, route screening before expensive simulations, and quotes pinned to a common block. Subgraphs discover pools; RPC reads supply the pool state and simulations used for quotes. Signed permits bypass the reusable quote response cache. Preserve these behaviors while hardening the service.

References: [Fly configuration](fly.toml), [production chain configuration](config/chains.production.json), [Dockerfile](packages/routing-api/Dockerfile), [existing deployment notes](docs/ROUTING_API_DEPLOYMENT.md).

**Observed quote timings**

Each chain received one ordinary exact-input quote followed immediately by the identical request. All eight responses returned HTTP 200. These are individual measurements from the review client's connection, including network latency, not averages, capacity measurements, or a latency guarantee.

| Chain | Pair and input | Response cache MISS | Immediate response cache HIT |
| --- | --- | ---: | ---: |
| BNB | 0.01 BNB to USDT | 2,580 ms | 101 ms |
| Robinhood | 0.001 ETH to USDG | 390 ms | 110 ms |
| Base | 0.001 ETH to USDC | 1,175 ms | 120 ms |
| Ethereum | 0.001 ETH to USDC | 688 ms | 105 ms |

“MISS” means the final quote response was computed; underlying dependency caches could already be warm. No cache-bypass flags, signed permits, transaction submissions, attack requests, or load tests were used. No local Docker containers were started and no `eth_getLogs` calls were used.

**1. Urgent: validate routing parameters and bound expensive work**

The public parser converts `maxHops`, `maxSplits`, and `distributionPercent` with `Number()` without enforcing appropriate finite integer ranges. A zero split step accepted from a GET query reaches a synchronous loop that cannot advance. The resulting process hang or memory exhaustion can affect every chain served by the instance. This was identified through source inspection and was **not triggered against production**.

Route enumeration also applies its route-count cap after generating paths. Its depth check uses equality, so invalid fractional or negative depths can bypass the intended stopping condition. Increasing the requested depth can make enumeration expensive even when only a small number of routes are eventually quoted.

Recommended work:

- Validate all public inputs before RPC work: token addresses/native aliases, positive bounded amounts, integer hop/split settings, a supported positive split-step set, recipient, slippage, and deadline ranges.
- Bound path enumeration and split-search work during generation. A final output cap does not bound the computation that precedes it.
- Add per-IP rate limits and a server-wide active-quote limit with a bounded queue or fast rejection. Use trusted Fly client-IP handling and `Retry-After` responses.
- Apply limits to cache bypasses and permit-bearing requests too; both can deliberately avoid response-cache reuse.
- Bound pending computations and cache memory, including token metadata. The response cache's entry count does not bound computations that continue after eviction.

These changes should precede any load testing. References: [request parser](packages/routing-api/src/server.ts), [split generation](packages/smart-order-router/src/routers/topaz-router.ts), [route enumeration](packages/smart-order-router/src/routers/compute-routes.ts), [response cache](packages/routing-api/src/cache.ts).

**2. High priority: configure primary and fallback RPCs per chain**

The production JSON supplies chain IDs and subgraph cache settings, without RPC overrides. BNB therefore uses the built-in public fallback list. Robinhood uses `rpc.mainnet.chain.robinhood.com`, Base uses `mainnet.base.org`, and Ethereum uses `ethereum-rpc.publicnode.com`; each spoke currently has one default endpoint.

There is a configuration trap: when `CHAINS_CONFIG_FILE` is set, `serverConfigFromEnv()` returns the JSON directly. The single-chain RPC and tuning environment variables are not merged into it. Adding an RPC secret alone would therefore not connect a private provider. Credentials used by the main data API are not automatically available to this separate Fly application.

Recommended work:

- Add an explicit, validated per-chain secret override mechanism, keeping credential-bearing URLs out of tracked JSON and logs.
- Configure a reliable primary and a verified fallback per chain. Check chain ID, recent block availability, and support for the router's multicall simulations.
- Measure provider latency from the actual Fly region before changing regions or buying larger Machines. Validate paid-provider performance rather than assuming a particular improvement.
- Budget requests across the maximum number of running replicas so autoscaling stays within provider quotas.

References: [server configuration/provider construction](packages/routing-api/src/server.ts), [chain defaults](packages/sdk-core/src/chains.ts), [BNB fallback list](packages/smart-order-router/src/providers/fallback-provider.ts).

**3. High priority: constrain retries, deadlines, and RPC concurrency**

The 16-batch concurrency limit is per multicall invocation, not per server or provider. Several requests and pipeline stages can run separate invocations concurrently. Fly's 30-request hard limit therefore does not impose a 16-RPC limit.

The multicall handler recursively halves every failed batch and retries both halves concurrently. That helps with simulation gas or payload limits, but transport errors, rate limits, or authentication failures can also trigger the split. This can multiply work during an upstream outage and ultimately turn an infrastructure failure into missing pool/quote results.

RPC attempts have a 20-second default timeout; BNB failover can try up to four endpoints sequentially. There is no overall quote deadline, and subgraph fetches have no explicit application timeout. The block-head fallback helper named `firstResolved` actually waits for all pending requests. Block-head refreshes also lack in-flight coalescing and can wait for slower endpoints despite receiving an early healthy response.

Recommended work:

- Share a bounded RPC scheduler across requests, with per-chain/provider limits and a total quote work budget.
- Split batches only for appropriate gas/payload failures. Handle transport failures with bounded retries, backoff, and provider cooldowns.
- Apply an overall quote deadline and dependency timeouts. Propagate cancellation to underlying I/O; a timed-out HTTP response alone does not stop the work. Preserve a shared computation while other live callers still need it.
- Coalesce head lookups, fix the first-response fallback behavior, and reject excessively lagging providers while preserving a block all chosen providers can serve.
- Distinguish upstream unavailability from a genuine absence of routes. Sanitize public errors instead of returning raw provider messages, especially once RPC credentials are introduced.

References: [multicall](packages/smart-order-router/src/providers/multicall.ts), [RPC fallback](packages/smart-order-router/src/providers/fallback-provider.ts), [subgraph requests](packages/smart-order-router/src/providers/subgraph.ts), [HTTP error handling](packages/routing-api/src/server.ts).

**4. High priority: reuse underlying reads without weakening quote freshness**

The current response cache already helps identical requests. Its key includes recipient, slippage, and deadline, however, so wallet-specific differences prevent reuse of otherwise identical route calculations. Different input amounts also repeat pool-state reads even when they use the same pools at the same block.

Subgraph pool-list refreshes have no shared in-flight refresh promise. Concurrent misses can fetch the same lists repeatedly. A caller's `skipCache` request also forces pool discovery to refresh, coupling quote freshness to an unnecessary index refresh.

Recommended work:

- Separate reusable route computation from wallet-specific calldata construction. Keep signed permits and personalized transaction payloads out of shared/public response caches.
- Cache immutable pool-state reads by chain, pool, and block identity, with bounded memory and reorg-aware invalidation. Keep all reads for a quote consistent with its chosen block.
- Coalesce pool-list refreshes. During a brief index outage, consider a bounded last-known-good discovery list while still reading current pool state; record its age because missing newly created pools can reduce route quality.
- Separate “recompute my quote” from “refresh pool discovery.” Rate-limit explicit discovery refreshes.
- Fetch gas price alongside independent work instead of waiting until all route simulations finish.
- Track the age of the block used for quoting. A one-second cache TTL measured after computation does not prove the underlying block is only one second old.

Start with bounded per-process caches and request coalescing. A new shared cache service is not necessary for the initial improvements. References: [quote cache key](packages/routing-api/src/quote.ts), [pool loading and gas-price lookup](packages/smart-order-router/src/routers/topaz-router.ts).

**5. High priority: two warm instances and bounded expansion**

One always-running instance avoids idle cold starts but remains a single point of failure. Recommend two warm Machines, initially retaining two shared CPUs and 1 GB RAM each. A third pre-provisioned Machine can be an optional stopped spare after request and RPC budgets are in place.

For that arrangement, use automatic stopping with a minimum of two running Machines in the primary region and automatic starting enabled. Fly's autostart mechanism only starts existing Machines; it does not create new ones. Limits must account for all three Machines running simultaneously.

Two Machines in one region protect against an individual Machine failure, not a whole-region outage. Measure demand, provider proximity, and failure behavior before adding regions or larger CPU allocations. Tune Fly concurrency to measured safe quote capacity rather than copying the main data API's limits.

References: [current Fly configuration](fly.toml), [Fly autostop/autostart documentation](https://fly.io/docs/reference/fly-proxy-autostop-autostart/).

**6. High priority: readiness, graceful shutdown, and useful monitoring**

`/health` currently returns an unconditional success response and enabled chain IDs. It confirms HTTP responsiveness without establishing whether the service can quote. There is no explicit shutdown handler to stop accepting requests and drain active quotes.

Recommended work:

- Separate liveness from readiness and track dependency health per chain. Use bounded background probes or recent successful operations so health checks do not create a new RPC workload.
- Keep healthy chains available when one chain's RPC or subgraph is down. Report that chain's degraded state clearly.
- Drain active requests on shutdown, with a deadline aligned to Fly's configured shutdown timeout. Handle overload and client disconnects explicitly.
- Record per-chain success/error rates, p50/p95/p99 latency, RPC call counts and latency, provider throttling, cache hit rates, active/queued work, event-loop lag, and quote block age.
- Alert on sustained quote failures, stale heads, and unavailable capacity. Fly health checks steer traffic away from unhealthy Machines but do not automatically restart a hung process.

References: [HTTP server and startup](packages/routing-api/src/server.ts), [Fly health checks](https://fly.io/docs/reference/health-checks/), [Fly shutdown configuration](https://fly.io/docs/reference/configuration/).

**Suggested implementation and verification order**

1. Close invalid-input and unbounded-work paths; add request admission limits and safe public errors.
2. Wire per-chain RPC secrets and fallbacks; enforce shared RPC budgets, deadlines, and selective retries.
3. Add readiness and draining, then provision two warm Machines and optionally a third spare.
4. Improve discovery/pool-state reuse and independent pipeline parallelism.
5. Establish per-chain latency and reliability baselines, then tune concurrency, provider choice, and machine size using those measurements.

Before publishing implementation changes, use isolated tests for invalid parameters, simulated dependency failures, bounded concurrency, cache isolation, and cancellation. Check quote and calldata correctness for exact-input and exact-output routes, mixed/split routes, and permits. After deployment, use bounded ordinary quote checks on every chain. Any later load or failover testing should be controlled and separate from this read-only review. Continue using subgraphs for indexed data and avoid local Docker workloads in this WSL environment.
