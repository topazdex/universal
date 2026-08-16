import { readFileSync } from 'fs'
import { resolve } from 'path'
import { Contract, ContractFactory, Signer } from 'ethers'

const ARTIFACT_PATH = resolve(
  __dirname,
  '../../../universal-router/out/UniversalRouter.sol/UniversalRouter.json'
)

export const BSC_MAINNET = {
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  weth9: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  v2Factory: '0x65E6cD0eF5D3467030103cf3d433034E570b5784',
  v2Implementation: '0xdC942D8e37cC20BCf9aD1Fe0111eE6c5908f3678',
  clFactory: '0x73DC984D9490286E735548f61dfCCec67Af82ed9',
  clImplementation: '0x18e68051d1b1fB44cb539cA4436F112D28577AF7'
}

/** Deploys the Universal Router from the foundry artifact, pointed at the live Topaz factories */
export async function deployUniversalRouter(signer: Signer): Promise<Contract> {
  let artifact: { abi: unknown[]; bytecode: { object: string } }
  try {
    artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8'))
  } catch (error) {
    throw new Error(
      `Universal Router artifact missing at ${ARTIFACT_PATH}. Run \`yarn workspace @topaz/universal-router build\` first. (${error})`
    )
  }

  const factory = new ContractFactory(artifact.abi as never, artifact.bytecode.object, signer)
  const router = await factory.deploy(BSC_MAINNET)
  await router.deployed()
  return router
}
