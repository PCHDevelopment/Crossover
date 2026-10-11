FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime

WORKDIR /app
COPY plugins/aws/package.json ./package.json
RUN npm install --prefix /app --omit=dev --no-package-lock

COPY plugins/aws/worker.mjs ./plugins/aws/worker.mjs
RUN chown -R 1000:1000 /app

USER 1000:1000
CMD ["node", "--use-env-proxy", "/app/plugins/aws/worker.mjs"]
