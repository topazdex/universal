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

/** Shared across chains, endpoints and every Multicall invocation in this process. */
export class WorkGate {
  private active = 0
  private readonly queue: { grant: () => void; reject: (error: Error) => void }[] = []
  public constructor(private readonly capacity = 12, private readonly maxQueue = 48) {}

  public async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
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
    try { signal.throwIfAborted(); return await task() }
    finally {
      const next = this.queue.shift()
      if (next) next.grant()
      else this.active--
    }
  }
}
