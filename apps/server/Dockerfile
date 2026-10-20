# Zoekt Apache-2.0; pinned source commit dated 2026-09-11.
ARG ZOEKT_COMMIT=153817f643cde8b229ee388c1dddbcf07f4798af
FROM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS zoekt
ARG ZOEKT_COMMIT
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/sourcegraph/zoekt/cmd/zoekt-git-index@${ZOEKT_COMMIT}

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build

WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @crossover/server... build \
    && pnpm --filter @crossover/server deploy --prod --legacy /prod/server
RUN find /prod/server -type f \( -name '*.map' -o -name '*.tsbuildinfo' -o -name '*.test.js' -o -name '*.test.d.ts' \) -exec rm -f '{}' \; \
    && rm -rf /prod/server/src \
    && rm -f /prod/server/Dockerfile /prod/server/tsconfig.json

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

RUN apk add --no-cache ca-certificates docker-cli git ripgrep
WORKDIR /app
COPY --from=build --chown=node:node /prod/server/ ./
COPY --from=zoekt /out/zoekt-git-index /usr/local/bin/

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
RUN mkdir -p /var/lib/crossover/zoekt && chown node:node /var/lib/crossover/zoekt
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
