FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
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
