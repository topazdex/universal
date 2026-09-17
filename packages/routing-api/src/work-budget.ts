import { AsyncLocalStorage } from 'async_hooks'

export class WorkLimitError extends Error {
  public constructor(public readonly code: 'quote_timeout' | 'rpc_budget_exceeded' | 'service_busy') {
    super(code)
  }
}

interface Budget { controller: AbortController; remaining: number }
const storage = new AsyncLocalStorage<Budget>()

/** Each computed quote owns its budget; joining a cached computation does not reset its deadline. */
export async function withQuoteBudget<T>(compute: () => Promise<T>, timeoutMs = 12_000, rpcCalls = 160): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new WorkLimitError('quote_timeout')), timeoutMs)
  try {
    return await storage.run({ controller, remaining: rpcCalls }, async () => {
      const result = await Promise.race([compute(), new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
      })])
      controller.signal.throwIfAborted()
      return result
    })
  } finally {
    clearTimeout(timer)
    // Cancel siblings still running after a failed Promise.all as well as their queue entries.
    controller.abort(new WorkLimitError('quote_timeout'))
  }
}

export function spendRpcCall(): AbortSignal | undefined {
  const budget = storage.getStore()
  if (!budget) return undefined
  budget.controller.signal.throwIfAborted()
  if (--budget.remaining < 0) {
    budget.controller.abort(new WorkLimitError('rpc_budget_exceeded'))
    throw budget.controller.signal.reason
  }
  return budget.controller.signal
}

export function quoteSignal(): AbortSignal | undefined { return storage.getStore()?.controller.signal }

export interface WorkGateState {
  active: number
  queued: number
  capacity: number
  /** Slots reclaimed from tasks that never settled after their signal aborted */
  abandoned: number
  /** Full, and nothing has settled for longer than any task is allowed to run: this process cannot quote */
  stuck: boolean
}

/**
 * Shared across chains, endpoints and every Multicall invocation in this process.
 *
 * A slot is released when its task settles, or shortly after its signal aborts — whichever comes
 * first. The second path exists because a fetch that has been aborted can, rarely, never settle
 * at all: in production that leaked one slot every ~10k calls until the gate was full and every
 * request on every chain queued behind phantom work and timed out. A leaked promise costs
 * nothing; a leaked slot takes the process down.
 */
export class WorkGate {
  private active = 0
  private abandoned = 0
  private lastSettledAt = Date.now()
  private readonly queue: { grant: () => void; reject: (error: Error) => void }[] = []
  public constructor(
    private readonly capacity = 12,
    private readonly maxQueue = 48,
    private readonly abandonAfterMs = 1_000,
    private readonly stuckAfterMs = 15_000
  ) {}

  public state(): WorkGateState {
    return {
      active: this.active,
      queued: this.queue.length,
      capacity: this.capacity,
      abandoned: this.abandoned,
      stuck: this.active >= this.capacity && Date.now() - this.lastSettledAt > this.stuckAfterMs
    }
  }

  /**
   * @param describe names the task in the log line written if its slot has to be reclaimed
   */
  public async run<T>(signal: AbortSignal, task: () => Promise<T>, describe?: () => string): Promise<T> {
    signal.throwIfAborted()
    if (this.active >= this.capacity) {
      if (this.queue.length >= this.maxQueue) throw new WorkLimitError('service_busy')
      await new Promise<void>((resolve, reject) => {
        const entry = { grant: () => { signal.removeEventListener('abort', abort); resolve() }, reject }
        const abort = () => {
          const index = this.queue.indexOf(entry)
          if (index >= 0) this.queue.splice(index, 1)
          reject(signal.reason)
        }
        this.queue.push(entry)
        signal.addEventListener('abort', abort, { once: true })
      })
    } else this.active++

    let grace: NodeJS.Timeout | undefined
    let abandon: (reason: unknown) => void = () => undefined
    const onAbort = () => {
      grace = setTimeout(() => {
        this.abandoned++
        console.error(`RPC slot reclaimed from a request that never settled after abort: ${describe?.() ?? 'unknown task'}`)
        abandon(signal.reason)
      }, this.abandonAfterMs)
    }
    try {
      signal.throwIfAborted()
      signal.addEventListener('abort', onAbort, { once: true })
      return await new Promise<T>((resolve, reject) => {
        abandon = reject
        task().then(resolve, reject)
      })
    } finally {
      signal.removeEventListener('abort', onAbort)
      clearTimeout(grace)
      this.lastSettledAt = Date.now()
      const next = this.queue.shift()
      if (next) next.grant()
      else this.active--
    }
  }
}
