#!/usr/bin/env python3
"""Verify a deployed Universal Router on BscScan.

`forge verify-contract` does not work for this project. Foundry compiles the whole project as one
solc invocation, and because the project builds with `via_ir = true`, a contract's bytecode depends
on the whole compilation unit — not just the files reachable from it. `--show-standard-json-input`
emits only the reachable subset, which compiles to different bytecode, so Etherscan rejects it with
"Compiled contract deployment bytecode does NOT match".

So this script captures the exact JSON foundry feeds solc, by pointing `forge build` at a wrapper
that tees stdin, and submits that. Nothing outside the temp directory is touched.

    ETHERSCAN_API_KEY=… python3 script/verify-bscscan.py 0xRouterAddress
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

API = 'https://api.etherscan.io/v2/api?chainid=56'  # one Etherscan V2 key covers BSC
CONTRACT = 'contracts/UniversalRouter.sol:UniversalRouter'
PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# must match script/constants/BscMainnet.sol
ROUTER_PARAMETERS = [
    '0x000000000022D473030F116dDEE9F6B43aC78BA3',  # permit2
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',  # WBNB
    '0x65E6cD0eF5D3467030103cf3d433034E570b5784',  # PoolFactory
    '0xdC942D8e37cC20BCf9aD1Fe0111eE6c5908f3678',  # Pool implementation
    '0x73DC984D9490286E735548f61dfCCec67Af82ed9',  # CLFactory
    '0x18e68051d1b1fB44cb539cA4436F112D28577AF7',  # CLPool implementation
]


def run(cmd, **kwargs):
    return subprocess.run(cmd, cwd=PACKAGE_ROOT, check=True, capture_output=True, text=True, **kwargs)


def capture_solc_input(workdir):
    """Rebuild through a solc wrapper that records what foundry actually sends."""
    solc = run(['forge', 'config', '--json']).stdout
    version = json.loads(solc).get('solc') or '0.8.17'
    real = os.path.expanduser(f'~/.local/share/svm/{version}/solc-{version}')
    if not os.path.exists(real):
        real = shutil.which('solc')
    if not real:
        sys.exit(f'could not find solc {version}; run `forge build` once so foundry downloads it')

    captured = os.path.join(workdir, 'solc-input.json')
    wrapper = os.path.join(workdir, 'solc')
    with open(wrapper, 'w') as f:
        f.write(f'#!/usr/bin/env bash\ntee "{captured}" | "{real}" "$@"\n')
    os.chmod(wrapper, 0o755)

    run(['forge', 'build', '--force', '--use', wrapper])
    with open(captured) as f:
        return json.load(f), version


def encode_constructor_args():
    signature = 'constructor((address,address,address,address,address,address))'
    tuple_arg = '(' + ','.join(ROUTER_PARAMETERS) + ')'
    return run(['cast', 'abi-encode', signature, tuple_arg]).stdout.strip()[2:]


def post(fields):
    request = urllib.request.Request(API, data=urllib.parse.urlencode(fields).encode())
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.load(response)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    address = sys.argv[1]
    key = os.environ.get('ETHERSCAN_API_KEY')
    if not key:
        sys.exit('ETHERSCAN_API_KEY is required')

    with tempfile.TemporaryDirectory() as workdir:
        source, version = capture_solc_input(workdir)
    print(f'captured foundry\'s solc input: {len(source["sources"])} sources, solc {version}')

    submission = post(
        {
            'module': 'contract',
            'action': 'verifysourcecode',
            'apikey': key,
            'codeformat': 'solidity-standard-json-input',
            'sourceCode': json.dumps(source),
            'contractaddress': address,
            'contractname': CONTRACT,
            'compilerversion': f'v{version}+commit.8df45f5f',
            'constructorArguements': encode_constructor_args(),
        }
    )
    if submission.get('status') != '1':
        sys.exit(f'submission rejected: {submission.get("result")}')
    guid = submission['result']
    print(f'submitted, guid {guid}')

    for _ in range(40):
        time.sleep(10)
        result = post({'module': 'contract', 'action': 'checkverifystatus', 'guid': guid, 'apikey': key})['result']
        print(f'  {result}')
        if result != 'Pending in queue':
            sys.exit(0 if 'Verified' in result or 'Pass' in result else 1)
    sys.exit('timed out waiting for Etherscan')


if __name__ == '__main__':
    main()
