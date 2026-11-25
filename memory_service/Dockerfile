# 记忆服务（better-sqlite3 需要 glibc，不用 Alpine）
FROM node:22-bookworm-slim

WORKDIR /app/memory_service

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY memory_service/package.json memory_service/package-lock.json ./
RUN npm ci --omit=dev

COPY memory_service/ ./

ENV NODE_ENV=production
EXPOSE 3013

CMD ["node", "server.js"]
