/**
 * A short-lived cache for quote responses, with in-flight coalescing.
 *
 * Every quote redoes the whole pipeline — pool state plus ~100 swap simulations — so two identical
 * requests seconds apart cost twice as much and return the same answer. BNB Chain produces a block
 * every 0.75s, so a quote is only meaningfully fresh for a block or two; a TTL in that range makes
 * repeat requests instant without letting a stale price reach a user.
 *
 * Coalescing matters as much as the TTL: without it, ten users loading the same pair at once fire
 * ten identical pipelines at the RPC.
 */
export interface CacheOptions {
  /**
   * How long a resolved value is served. 0 disables caching entirely.
   *
   * Kept near BNB Chain's 0.75s block time on purpose: long enough to collapse duplicate renders
   * and concurrent callers, short enough that nobody is looking at a materially old price. A caller
   * who wants fresh data regardless can say so; see `resolve`.
   */
  ttlMs?: number
  /** Entries kept before the oldest are dropped */
  maxEntries?: number
}

interface Entry<T> {
  value: Promise<T>
  /** Set once the promise resolves; until then the entry is only a coalescing target */
  expiresAt?: number
  computedAt?: number
}

export interface CacheOutcome<T> {
  value: T
  /** True when the value came from a previous request rather than this one */
  hit: boolean
  /** How long ago the value was computed, in ms */
  ageMs: number
}

export class ResponseCache<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private readonly ttlMs: number
  private readonly maxEntries: number

  public constructor(options: CacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 1_000
    this.maxEntries = options.maxEntries ?? 500
  }

  public get enabled(): boolean {
    return this.ttlMs > 0
  }

  /**
   * Returns the cached value, joins a request already in flight, or runs `compute`.
   *
   * `bypass` is for a caller who has explicitly asked for fresh data. It skips the cached value
   * *and* any request in flight — joining one started a second ago would hand back exactly the
   * staleness they were trying to escape — then stores the fresh result for everyone else.
   */
  public async resolve(key: string, compute: () => Promise<T>, bypass = false): Promise<T> {
    if (!this.enabled) return compute()

    if (!bypass) {
      const existing = this.entries.get(key)
      if (existing && (existing.expiresAt === undefined || existing.expiresAt > Date.now())) {
        return existing.value
      }
    }

    const entry: Entry<T> = {
      value: compute().then(
        value => {
          entry.expiresAt = Date.now() + this.ttlMs
          entry.computedAt = Date.now()
          return value
        },
        error => {
          // a failure must not be cached, or one RPC blip is served for the whole TTL
          if (this.entries.get(key) === entry) this.entries.delete(key)
          throw error
        }
      )
    }

    this.entries.set(key, entry)
    this.evict()
    return entry.value
  }

  /** As `resolve`, but reports whether the value was reused and how old it is */
  public async resolveWithOutcome(
    key: string,
    compute: () => Promise<T>,
    bypass = false
  ): Promise<CacheOutcome<T>> {
    const existing = bypass ? undefined : this.entries.get(key)
    const hit = Boolean(existing && (existing.expiresAt === undefined || existing.expiresAt > Date.now()))

    const value = await this.resolve(key, compute, bypass)
    const entry = this.entries.get(key)
    const ageMs = hit && entry?.computedAt ? Date.now() - entry.computedAt : 0

    return { value, hit, ageMs }
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return
    const now = Date.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) this.entries.delete(key)
    }
    // insertion ordered, so the front is the oldest
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }
}
