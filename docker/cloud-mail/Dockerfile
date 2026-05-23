FROM node:22-alpine AS frontend

WORKDIR /app

RUN corepack enable && mkdir -p mail-worker

COPY mail-vue/package.json mail-vue/pnpm-lock.yaml ./mail-vue/
RUN pnpm --dir mail-vue install --frozen-lockfile

COPY mail-vue ./mail-vue
RUN pnpm --dir mail-vue run build

FROM node:22-alpine

WORKDIR /app/mail-worker

ENV NODE_ENV=production

RUN corepack enable && mkdir -p /data

COPY mail-worker/package.json mail-worker/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY mail-worker ./
COPY --from=frontend /app/mail-worker/dist ./dist
COPY docker/cloud-mail/entrypoint.sh /usr/local/bin/cloud-mail-entrypoint

RUN chmod +x /usr/local/bin/cloud-mail-entrypoint && chown -R node:node /app /data

USER node

EXPOSE 8787

ENTRYPOINT ["cloud-mail-entrypoint"]
