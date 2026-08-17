import { Pool as CLPool } from '@topazdex/v3-sdk'
import { Pool as V2Pool } from '@topazdex/v2-sdk'

/** The Topaz liquidity stacks a route can touch */
export enum Protocol {
  /** Solidly pools, volatile or stable */
  V2 = 'V2',
  /** Slipstream concentrated liquidity, referred to as v3 across the Topaz stack */
  CL = 'CL',
  /** A single route that crosses both */
  MIXED = 'MIXED'
}

export type TPool = V2Pool | CLPool

export function isCLPool(pool: TPool): pool is CLPool {
  return pool instanceof CLPool
}

export function isV2Pool(pool: TPool): pool is V2Pool {
  return pool instanceof V2Pool
}
