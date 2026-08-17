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
  /** How long a resolved value is served. 0 disables caching entirely. */
  ttlMs?: number
  /** Entries kept before the oldest are dropped */
  maxEntries?: number
}

interface Entry<T> {
  value: Promise<T>
  /** Set once the promise resolves; until then the entry is only a coalescing target */
  expiresAt?: number
}

export class ResponseCache<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private readonly ttlMs: number
  private readonly maxEntries: number

  public constructor(options: CacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 2_000
    this.maxEntries = options.maxEntries ?? 500
  }

  public get enabled(): boolean {
    return this.ttlMs > 0
  }

  /** Returns the cached value, joins a request already in flight, or runs `compute` */
  public async resolve(key: string, compute: () => Promise<T>): Promise<T> {
    if (!this.enabled) return compute()

    const existing = this.entries.get(key)
    if (existing && (existing.expiresAt === undefined || existing.expiresAt > Date.now())) {
      return existing.value
    }

    const entry: Entry<T> = {
      value: compute().then(
        value => {
          entry.expiresAt = Date.now() + this.ttlMs
          return value
        },
        error => {
          // a failure must not be cached, or one RPC blip is served for the whole TTL
          this.entries.delete(key)
          throw error
        }
      )
    }

    this.entries.set(key, entry)
    this.evict()
    return entry.value
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
