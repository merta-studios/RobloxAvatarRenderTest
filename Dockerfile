FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY src/renderer-client.js src/renderer.css ./src/
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    NODE_OPTIONS=--max-old-space-size=160
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src/server.js src/config.js src/commands.js src/roblox.js src/discord-net.js ./src/
USER node
EXPOSE 10000
CMD ["node", "src/server.js"]
