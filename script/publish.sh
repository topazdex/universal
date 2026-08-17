#!/usr/bin/env bash
#
# Publishes the public @topazdex packages to npm, in dependency order.
#
#   npm login          # or set an automation token in ~/.npmrc
#   ./script/publish.sh --dry-run
#   ./script/publish.sh
#
# Uses `yarn npm publish`, not `npm publish`: yarn rewrites the `workspace:*` ranges into real
# versions on the way out. Publishing these with plain npm would ship unresolvable dependencies.
#
# @topazdex/routing-api is deliberately absent — it is a service, and marked private.
set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# dependency order: a package must exist on the registry before anything that depends on it
PACKAGES=(
  "@topazdex/sdk-core"
  "@topazdex/v2-sdk"
  "@topazdex/v3-sdk"
  "@topazdex/router-sdk"
  "@topazdex/universal-router-sdk"
  "@topazdex/smart-order-router"
  "@topazdex/universal-router"
)

# `npm login` writes its token to ~/.npmrc, which Yarn does not read. Bridge it, without ever
# putting the token in a file the repo tracks.
if [[ -z "${YARN_NPM_AUTH_TOKEN:-}" && -f "$HOME/.npmrc" ]]; then
  YARN_NPM_AUTH_TOKEN=$(grep -m1 '//registry.npmjs.org/:_authToken=' "$HOME/.npmrc" | sed 's/.*_authToken=//' | tr -d '"')
  export YARN_NPM_AUTH_TOKEN
fi

if ! $DRY_RUN; then
  echo "==> checking authentication"
  # --publish: the token is scoped to registry.npmjs.org, not Yarn's default read mirror
  yarn npm whoami --publish || {
    echo "not logged in: run 'npm login', or put an automation token in ~/.npmrc" >&2
    exit 1
  }
fi

echo "==> building"
yarn build

if ! $DRY_RUN; then
  echo "==> testing"
  yarn test
fi

for package in "${PACKAGES[@]}"; do
  version=$(yarn workspace "$package" exec node -p "require('./package.json').version")
  echo
  echo "==> $package@$version"

  if ! $DRY_RUN && yarn npm info "$package@$version" --json >/dev/null 2>&1; then
    echo "    already published, skipping"
    continue
  fi

  if $DRY_RUN; then
    yarn workspace "$package" pack --dry-run | tail -5
  else
    yarn workspace "$package" npm publish --access public
  fi
done

echo
$DRY_RUN && echo "dry run complete, nothing published" || echo "published"
