FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build

WORKDIR /repo
RUN corepack enable
# Fetch the dependencies from the lockfile alone, so this layer is cached until the lockfile changes.
# `pnpm fetch` also links a node_modules; it is deleted so the install below creates it as it always did.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch --frozen-lockfile && rm -rf node_modules
COPY . .
RUN pnpm install --offline --frozen-lockfile \
    && pnpm --filter @crossover/server... build \
    && pnpm --filter @crossover/server deploy --prod --legacy /prod/server
RUN find /prod/server -type f \( -name '*.map' -o -name '*.tsbuildinfo' -o -name '*.test.js' -o -name '*.test.d.ts' \) -exec rm -f '{}' \; \
    && rm -rf /prod/server/src \
    && rm -f /prod/server/Dockerfile /prod/server/tsconfig.json

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

RUN apk add --no-cache ca-certificates docker-cli git
WORKDIR /app
COPY --from=build --chown=node:node /prod/server/ ./

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
