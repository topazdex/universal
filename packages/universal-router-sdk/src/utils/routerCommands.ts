import { defaultAbiCoder } from '@ethersproject/abi'

/**
 * Command values are the Topaz Universal Router's, which keeps the Uniswap and Velodrome numbering
 * for every command it supports. Commands upstream reserves for NFT marketplaces do not exist here.
 */
export enum CommandType {
  V3_SWAP_EXACT_IN = 0x00,
  V3_SWAP_EXACT_OUT = 0x01,
  PERMIT2_TRANSFER_FROM = 0x02,
  PERMIT2_PERMIT_BATCH = 0x03,
  SWEEP = 0x04,
  TRANSFER = 0x05,
  PAY_PORTION = 0x06,
  TRANSFER_FROM = 0x07,

  V2_SWAP_EXACT_IN = 0x08,
  V2_SWAP_EXACT_OUT = 0x09,
  PERMIT2_PERMIT = 0x0a,
  WRAP_ETH = 0x0b,
  UNWRAP_WETH = 0x0c,
  PERMIT2_TRANSFER_FROM_BATCH = 0x0d,
  BALANCE_CHECK_ERC20 = 0x0e,

  EXECUTE_SUB_PLAN = 0x21
}

const ALLOW_REVERT_FLAG = 0x80
const REVERTIBLE_COMMANDS = new Set<CommandType>([CommandType.EXECUTE_SUB_PLAN])

const PERMIT_STRUCT =
  '((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline)'
const PERMIT_BATCH_STRUCT =
  '((address token,uint160 amount,uint48 expiration,uint48 nonce)[] details,address spender,uint256 sigDeadline)'
const PERMIT2_TRANSFER_FROM_BATCH_STRUCT = '(address from,address to,uint160 amount,address token)[]'
/** Topaz v2 hops carry the volatile/stable flag with them */
const V2_ROUTE_STRUCT = '(address from,address to,bool stable)[]'

const ABI_DEFINITION: { [type in CommandType]: string[] } = {
  [CommandType.V3_SWAP_EXACT_IN]: ['address', 'uint256', 'uint256', 'bytes', 'bool'],
  [CommandType.V3_SWAP_EXACT_OUT]: ['address', 'uint256', 'uint256', 'bytes', 'bool'],
  [CommandType.PERMIT2_TRANSFER_FROM]: ['address', 'address', 'uint160'],
  [CommandType.PERMIT2_PERMIT_BATCH]: [PERMIT_BATCH_STRUCT, 'bytes'],
  [CommandType.SWEEP]: ['address', 'address', 'uint256'],
  [CommandType.TRANSFER]: ['address', 'address', 'uint256'],
  [CommandType.PAY_PORTION]: ['address', 'address', 'uint256'],
  [CommandType.TRANSFER_FROM]: ['address', 'address', 'uint256'],

  [CommandType.V2_SWAP_EXACT_IN]: ['address', 'uint256', 'uint256', V2_ROUTE_STRUCT, 'bool'],
  [CommandType.V2_SWAP_EXACT_OUT]: ['address', 'uint256', 'uint256', V2_ROUTE_STRUCT, 'bool'],
  [CommandType.PERMIT2_PERMIT]: [PERMIT_STRUCT, 'bytes'],
  [CommandType.WRAP_ETH]: ['address', 'uint256'],
  [CommandType.UNWRAP_WETH]: ['address', 'uint256'],
  [CommandType.PERMIT2_TRANSFER_FROM_BATCH]: [PERMIT2_TRANSFER_FROM_BATCH_STRUCT],
  [CommandType.BALANCE_CHECK_ERC20]: ['address', 'address', 'uint256'],

  [CommandType.EXECUTE_SUB_PLAN]: ['bytes', 'bytes[]']
}

export class RoutePlanner {
  public commands: string
  public inputs: string[]

  public constructor() {
    this.commands = '0x'
    this.inputs = []
  }

  public addSubPlan(subplan: RoutePlanner): void {
    this.addCommand(CommandType.EXECUTE_SUB_PLAN, [subplan.commands, subplan.inputs], true)
  }

  public addCommand(type: CommandType, parameters: unknown[], allowRevert = false): void {
    const command = createCommand(type, parameters)
    this.inputs.push(command.encodedInput)
    if (allowRevert) {
      if (!REVERTIBLE_COMMANDS.has(command.type)) {
        throw new Error(`command type: ${CommandType[type]} cannot be allowed to revert`)
      }
      this.commands = this.commands.concat((command.type | ALLOW_REVERT_FLAG).toString(16).padStart(2, '0'))
    } else {
      this.commands = this.commands.concat(command.type.toString(16).padStart(2, '0'))
    }
  }
}

export interface RouterCommand {
  type: CommandType
  encodedInput: string
}

export function createCommand(type: CommandType, parameters: unknown[]): RouterCommand {
  const encodedInput = defaultAbiCoder.encode(ABI_DEFINITION[type], parameters)
  return { type, encodedInput }
}
