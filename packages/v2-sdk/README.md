# @topaz/v2-sdk

Topaz v2 pools: Solidly-style volatile (`xy = k`) and stable (`x³y + xy³ = k`) AMMs.

## What it does differently from `@uniswap/v2-sdk`

- **Pools are keyed `(token0, token1, stable)`.** A pair can have both a volatile and a stable pool,
  at different addresses.
- **Addresses are clone addresses.** `PoolFactory` deploys ERC-1167 clones of a single `Pool`
  implementation, so the address derives from that implementation rather than from pool init code.
- **Fees are per pool and read from the factory.** `PoolFactory.getFee(pool, stable)` returns basis
  points against 10 000 (`30` is 0.30%) and can be overridden per pool, so nothing is hardcoded.
- **Stable pools have no exact output.** The stable invariant has no closed form inverse;
  `getInputAmount` throws `StableExactOutputError`, matching the Universal Router's own refusal.

The arithmetic mirrors `Pool.sol` step for step — including the order of integer divisions and the
Newton iteration in `_get_y` — so a quote equals what the pool returns, to the wei.

## Usage

```ts
import { CurrencyAmount } from '@topaz/sdk-core'
import { Pool, Route, Trade } from '@topaz/v2-sdk'

const pool = Pool.fromReserves(WBNB, USDT, reserve0, reserve1, /* stable */ false, /* fee bips */ 30)
const [amountOut] = pool.getOutputAmount(CurrencyAmount.fromRawAmount(WBNB, '1000000000000000000'))

Pool.getAddress(WBNB, USDT, false) // derived off chain, no RPC call
```

## Tests

`src/mainnet.test.ts` loads live reserves and fees from BNB Chain and asserts the SDK's quote equals
`Pool.getAmountOut` exactly, for both curves and both directions.
