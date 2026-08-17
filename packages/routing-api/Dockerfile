# Build the workspace, then ship only the routing API and its runtime dependencies.
FROM node:22-slim AS build
WORKDIR /app

RUN corepack enable

# manifests first, so a dependency-free code change reuses the install layer
COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json ./
COPY packages/sdk-core/package.json packages/sdk-core/
COPY packages/v2-sdk/package.json packages/v2-sdk/
COPY packages/v3-sdk/package.json packages/v3-sdk/
COPY packages/router-sdk/package.json packages/router-sdk/
COPY packages/universal-router-sdk/package.json packages/universal-router-sdk/
COPY packages/smart-order-router/package.json packages/smart-order-router/
COPY packages/routing-api/package.json packages/routing-api/
# the router package has no npm dependencies, but omitting it changes the workspace set and
# `--immutable` then refuses the lockfile
COPY packages/universal-router/package.json packages/universal-router/
RUN yarn install --immutable

COPY packages/ packages/
# built explicitly in dependency order: the router package is Solidity only, and its build script
# shells out to forge, which is not in this image
RUN yarn workspace @topazdex/sdk-core build \
 && yarn workspace @topazdex/v2-sdk build \
 && yarn workspace @topazdex/v3-sdk build \
 && yarn workspace @topazdex/router-sdk build \
 && yarn workspace @topazdex/universal-router-sdk build \
 && yarn workspace @topazdex/smart-order-router build \
 && yarn workspace @topazdex/routing-api build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable

COPY --from=build /app/package.json /app/yarn.lock /app/.yarnrc.yml ./
COPY --from=build /app/packages ./packages
RUN yarn workspaces focus --production --all && yarn cache clean

# never run as root
USER node
EXPOSE 3000

# the API is stateless; readiness is a live RPC connection, which /health does not prove
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/routing-api/dist/server.js"]
