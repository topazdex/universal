#!/usr/bin/env bash
#
# Publishes the public @topazdex packages to npm, in dependency order.
#
#   ./script/publish.sh --dry-run           # packs everything, publishes nothing
#   ./script/publish.sh --otp=123456        # interactive login: npm asks for a 2FA code
#   ./script/publish.sh                     # automation token in ~/.npmrc: no code needed
#
# An automation token (npmjs.com -> Access Tokens -> Granular, with publish rights) bypasses 2FA,
# which is what CI wants. A normal `npm login` session still requires --otp on every publish.
#
# Uses `yarn npm publish`, not `npm publish`: yarn rewrites the `workspace:*` ranges into real
# versions on the way out. Publishing these with plain npm would ship unresolvable dependencies.
#
# @topazdex/routing-api is deliberately absent — it is a service, and marked private.
set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN=false
OTP=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --otp=*) OTP="${arg#--otp=}" ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

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
  npm whoami --registry https://registry.npmjs.org || {
    echo "not logged in: run 'npm login'" >&2
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

  # yarn packs (it rewrites the workspace:* ranges into real versions), npm publishes (it holds
  # the credentials). Publishing the raw workspace manifest with npm would ship unresolvable deps.
  tarball="$(mktemp -d)/${package//\//-}.tgz"
  yarn workspace "$package" pack --out "$tarball" >/dev/null

  if $DRY_RUN; then
    echo "    packed $(du -h "$tarball" | cut -f1), deps:"
    tar -xzOf "$tarball" package/package.json | node -e \
      'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const [k,v] of Object.entries(d.dependencies||{}))if(k.startsWith("@topazdex/"))console.log("      "+k+" "+v)'
  else
    # an OTP is valid for about 30 seconds, so a long run may need a fresh one partway through
    npm publish "$tarball" --access public --registry https://registry.npmjs.org \
      ${OTP:+--otp="$OTP"}
  fi
done

echo
$DRY_RUN && echo "dry run complete, nothing published" || echo "published"
