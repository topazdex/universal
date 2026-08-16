export class InsufficientReservesError extends Error {
  public readonly isInsufficientReservesError = true

  public constructor() {
    super('Insufficient reserves')
    this.name = this.constructor.name
  }
}

export class InsufficientInputAmountError extends Error {
  public readonly isInsufficientInputAmountError = true

  public constructor() {
    super('Insufficient input amount')
    this.name = this.constructor.name
  }
}

/**
 * The Solidly stable invariant cannot be inverted in closed form, so neither the pool nor the
 * Universal Router can serve an exact output swap from a stable pool.
 */
export class StableExactOutputError extends Error {
  public readonly isStableExactOutputError = true

  public constructor() {
    super('Exact output is not supported by stable pools')
    this.name = this.constructor.name
  }
}
