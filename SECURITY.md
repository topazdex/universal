# Security

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private vulnerability reporting: the
[**Security** tab](https://github.com/topazdex/universal/security/advisories/new) → *Report a
vulnerability*. It opens a private thread with the maintainers, and it is the only channel that gets
you a response before the details are public.

Please include:

- which component — the router contract, one of the SDKs, or the quote service
- what an attacker gains, concretely (funds at risk, wrong quote, denial of service)
- a way to reproduce it: for the contract, a `forge` test against a mainnet fork; for the SDKs or the
  API, the pair, amount, trade type and **block number**, since a quote is only reproducible pinned
  to a block

You will get an acknowledgement, and we will tell you what we intend to do and roughly when. If we
disagree that something is a vulnerability we will explain why rather than going quiet. Please give
us a chance to ship a fix before publishing.

## Scope

| in scope | |
| --- | --- |
| `UniversalRouter` at [`0x691e…F6A6`](https://bscscan.com/address/0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6) and the source in `packages/universal-router` | funds at risk, unauthorised callbacks, slippage limits that do not bind, command dispatch flaws |
| The published `@topazdex/*` packages | calldata that does not do what the trade says, slippage or deadline encoded wrongly, quote maths that disagrees with the chain |
| `quote.topazdex.com` | quotes that are wrong in a way an attacker can steer, calldata that pays out to the wrong address, anything that lets one caller deny service to others |

**Out of scope**, because they are known and documented rather than undiscovered:

- **No rate limiting on `quote.topazdex.com`.** It is public and unauthenticated, and each quote is
  ~16 `eth_call`s against public RPCs. One script can degrade it. This is a known operational gap,
  tracked in [`CLAUDE.md`](CLAUDE.md); reports that it can be hammered are not new information.
- **Fee-on-transfer tokens are not modelled.** Quotes price the pool maths, not a token's transfer
  hook, so the received amount for a taxing token can breach `minimumAmountOut`. Documented in
  [`docs/FRONTEND_INTEGRATION.md`](docs/FRONTEND_INTEGRATION.md).
- **Stale quotes revert.** The deadline and slippage limit are baked into the calldata at quote time.
  A quote left on screen expiring is the intended behaviour.
- Third-party infrastructure: BNB Chain itself, Permit2, public RPC providers, the subgraphs.
- Reports produced by a scanner with no demonstrated impact.

## What the router's design already rules out

Worth knowing before you spend time on a report:

- **It is immutable.** No owner, no proxy, no upgrade path, no admin functions. Its parameters are
  baked into the runtime code at deploy. There is no privileged role to compromise.
- **It holds no funds between transactions.** Every command sequence ends by paying out, and
  `receive()` is restricted to WBNB so stray BNB cannot be parked in it. A balance sitting in the
  router mid-transaction is spendable by the rest of that transaction only.
- **The deployed bytecode is this source**, byte for byte — asserted by `DeployedRouterForkTest` and
  verified on BscScan. You can check it yourself:

  ```bash
  cd packages/universal-router
  DEPLOYED_UNIVERSAL_ROUTER=0x691e6171e0a434FfE5C9f1759621D05b9efcF6A6 forge test
  ```

None of that makes it correct — it means a vulnerability here is a logic flaw in the command set or
the pool maths, not a key-management or upgrade problem.

## Supported versions

The npm packages are at `0.1.0` and only the latest release is supported. There is one deployed
router; because it is immutable, a fix to the contract means a new deployment and an updated address
in `UNIVERSAL_ROUTER_ADDRESSES`, not an upgrade.

Frontends should take the router address from the `to` field of the quote response rather than
hardcoding it, so an address change does not require a release on your side.
