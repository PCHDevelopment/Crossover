FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY plugins/browser/package.json ./package.json
RUN npm install --prefix /app --omit=dev --no-package-lock \
    && mkdir -p /ms-playwright \
    && PLAYWRIGHT_BROWSERS_PATH=/ms-playwright /app/node_modules/.bin/playwright-core install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chown -R 1000:1000 /app /ms-playwright

COPY plugins/browser/worker.mjs ./plugins/browser/worker.mjs
RUN chown -R 1000:1000 /app/plugins

USER 1000:1000
CMD ["node", "/app/plugins/browser/worker.mjs"]

FROM runtime AS test
COPY plugins/browser/test/worker.mjs ./plugins/browser/test/worker.mjs

FROM runtime AS production
