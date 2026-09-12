#!/usr/bin/env node
/** Reproduce a recorded router deployment and prepare public explorer submission files. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { utils } = require('ethers')

function main() {
  const [chain, outputDirectory] = process.argv.slice(2)
  if (!chain || !/^[a-z0-9_-]+$/.test(chain) || !outputDirectory) {
    throw new Error('Usage: node script/prepare-verification.cjs <chain> <output-directory>')
  }
  const root = path.resolve(__dirname, '..')
  const deployments = path.join(root, 'deployment-addresses')
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
  const record = read(path.join(deployments, `${chain}-deployment.json`))
  const artifact = read(path.join(deployments, record.artifactFile))
  const manifest = read(path.join(deployments, 'router-verification-manifest.json'))
  const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata
  assert.equal(metadata.compiler.version, manifest.compilerVersion, 'Compiler version differs from deployment')

  const sources = {}
  for (const [name, info] of Object.entries(manifest.sources)) {
    const filename = path.resolve(root, name)
    assert(filename.startsWith(root + path.sep), `Invalid source path: ${name}`)
    const content = fs.readFileSync(filename, 'utf8')
    assert.equal(utils.keccak256(utils.toUtf8Bytes(content)), info.keccak256, `Source changed: ${name}`)
    sources[name] = { content }
  }
  for (const [name, info] of Object.entries(metadata.sources)) {
    assert.equal(manifest.sources[name]?.keccak256, info.keccak256, `Artifact source differs: ${name}`)
  }
  const input = { language: manifest.language, sources, settings: manifest.settings }
  const version = manifest.compilerVersion.split('+')[0]
  const solc = process.env.SOLC || path.join(os.homedir(), '.local/share/svm', version, `solc-${version}`)
  const compilerDescription = execFileSync(solc, ['--version'], { encoding: 'utf8' })
  assert(compilerDescription.includes(manifest.compilerVersion), 'SOLC must match the recorded compiler version')
  const output = JSON.parse(
    execFileSync(solc, ['--standard-json'], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024
    })
  )
  const errors = (output.errors || []).filter((error) => error.severity === 'error')
  assert.equal(errors.length, 0, errors.map((error) => error.formattedMessage).join('\n'))
  const [sourceName, contractName] = manifest.contractIdentifier.split(':')
  const bytecode = '0x' + output.contracts[sourceName][contractName].evm.bytecode.object
  assert.equal(bytecode, artifact.bytecode.object, 'Compiled creation bytecode differs from the saved artifact')
  assert.equal(utils.keccak256(bytecode), manifest.creationBytecodeHash, 'Unexpected creation bytecode hash')

  const fields = ['permit2', 'weth9', 'v2Factory', 'v2Implementation', 'clFactory', 'clImplementation']
  const parameters = fields.map((field) => record.constructorParameters[field])
  const argumentsHex = utils.defaultAbiCoder
    .encode(['tuple(address,address,address,address,address,address)'], [parameters])
    .slice(2)
  assert.equal(
    utils.keccak256(bytecode + argumentsHex),
    record.creationInputHash,
    'Constructor arguments differ from the recorded transaction'
  )

  const destination = path.resolve(outputDirectory)
  fs.mkdirSync(destination, { recursive: true })
  const summary = {
    chainId: record.chainId,
    address: record.UniversalRouter,
    transactionHash: record.transactionHash,
    contractIdentifier: manifest.contractIdentifier,
    compilerVersion: manifest.compilerVersion,
    sourceCount: Object.keys(sources).length,
    creationBytecodeHash: utils.keccak256(bytecode),
    creationInputHash: record.creationInputHash,
    constructorArguments: argumentsHex
  }
  fs.writeFileSync(path.join(destination, 'standard-input.json'), JSON.stringify(input))
  fs.writeFileSync(path.join(destination, 'constructor-arguments.txt'), argumentsHex + '\n')
  fs.writeFileSync(path.join(destination, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(
    `Prepared ${chain} verification in ${destination}; compiler output and constructor arguments match the recorded deployment.`
  )
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
