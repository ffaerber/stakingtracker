# Multi-stage build: build the web frontend and the server, then a slim runtime
# that serves the static frontend + API from one container.

FROM node:22-bookworm AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM node:22-bookworm AS server
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install
COPY server/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app/server
ENV NODE_ENV=production
ENV STT_WEB_DIR=/app/web/dist
ENV STT_DB_PATH=/data/stakingtracker.db
COPY --from=server /app/server/node_modules ./node_modules
COPY --from=server /app/server/dist ./dist
COPY --from=server /app/server/package.json ./package.json
COPY --from=web /app/web/dist /app/web/dist
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/index.js"]
