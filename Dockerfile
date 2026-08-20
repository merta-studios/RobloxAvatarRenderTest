FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
# Gesamtes src/ kopieren: renderer-client.js importiert asset-urls.js (und weitere
# Module). Cherry-Picking einzelner Dateien lässt `vite build` mit
# "Could not resolve ./asset-urls.js" scheitern – Render behält dann den
# vorherigen Deploy, und Discord zeigt weiter die alte Fehlermeldung ohne
# "Fehlerstufe:".
COPY src ./src
# draco_decoder.js (klassisches Script, setzt das globale DracoDecoderModule)
# muss vor dem gebündelten Renderer geladen werden; Vite kopiert public/ 1:1 nach dist/.
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ARG GIT_COMMIT=unknown
ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    NODE_OPTIONS=--max-old-space-size=160 \
    GIT_COMMIT=${GIT_COMMIT}
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
USER node
EXPOSE 10000
CMD ["node", "src/server.js"]
