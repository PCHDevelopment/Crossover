# Node.js v22.21.0 or newer is required for --use-env-proxy.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build

WORKDIR /build
COPY packages/github-api/package.json ./packages/github-api/package.json
COPY packages/github-api/index.ts ./packages/github-api/index.ts
RUN npm install --prefix /opt/tsc --no-save --package-lock=false typescript@6.0.3 @types/node@22.20.5
RUN /opt/tsc/node_modules/.bin/tsc \
  --target ES2023 \
  --lib ES2023 \
  --module NodeNext \
  --moduleResolution NodeNext \
  --strict \
  --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes \
  --verbatimModuleSyntax \
  --isolatedModules \
  --declaration false \
  --sourceMap false \
  --skipLibCheck \
  --typeRoots /opt/tsc/node_modules/@types \
  --types node \
  --outDir /out \
  packages/github-api/index.ts

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime

WORKDIR /app
COPY packages/github-api/package.json ./packages/github-api/package.json
COPY --from=build /out/index.js ./packages/github-api/dist/index.js
COPY plugins/github/worker.mjs ./plugins/github/worker.mjs

USER 1000:1000
CMD ["node", "--use-env-proxy", "/app/plugins/github/worker.mjs"]
