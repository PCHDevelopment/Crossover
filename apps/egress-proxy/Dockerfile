FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
# Fetch the dependencies from the lockfile alone, so this layer is cached until the lockfile changes.
# `pnpm fetch` also links a node_modules; it is deleted so the install below creates it as it always did.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch --frozen-lockfile && rm -rf node_modules
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @crossover/egress-proxy build

FROM node:22-bookworm-slim
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/db ./packages/db
COPY --from=build /repo/packages/security ./packages/security
COPY --from=build /repo/apps/egress-proxy ./apps/egress-proxy
USER node
EXPOSE 3128
CMD ["node", "apps/egress-proxy/dist/main.js"]
