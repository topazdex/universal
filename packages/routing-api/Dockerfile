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
RUN yarn install --immutable

COPY packages/ packages/
# the router package is Solidity only; the API never imports it
RUN yarn workspaces foreach --all --topological-dev --exclude @topazdex/universal-router run build

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
