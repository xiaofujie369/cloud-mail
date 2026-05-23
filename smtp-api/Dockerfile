FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    SMTP_DATA_DIR=/data

WORKDIR /app

COPY package.json ./
COPY src ./src

RUN mkdir -p /data && chown -R node:node /app /data

USER node

EXPOSE 8080

CMD ["node", "src/server.js"]
