# syntax=docker/dockerfile:1
# PaySim en une seule image : l'API Express sert aussi le front buildé, comme `npm run build && npm start` (README).
#
#   docker build -t paysim .
#   docker run -d --name paysim -p 4000:4000 -v paysim-data:/data paysim
#
# NODE_ENV n'est volontairement PAS fixé à `production` : ce mode exige une VAULT_KEY personnalisée, désactive
# l'horloge de test et active `upgrade-insecure-requests` (la démo doit alors être servie en HTTPS). Voir .env.example.

# ---- 1. Build du front (web/dist) ----
FROM node:22-alpine AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/ ./
RUN npm run build

# ---- 2. Dépendances de production du serveur ----
# better-sqlite3 est un module natif : un binaire précompilé est téléchargé ; python3/make/g++ servent de secours
# (compilation locale) et ne sont pas embarqués dans l'image finale.
FROM node:22-alpine AS server-deps
RUN apk add --no-cache python3 make g++
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ---- 3. Image finale ----
FROM node:22-alpine
ENV PORT=4000 \
    DB_PATH=/data/paysim.db \
    WEB_DIST_DIR=/app/web/dist
WORKDIR /app/server
COPY --from=server-deps /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY --from=web-build /app/web/dist /app/web/dist
# La base SQLite vit dans /data (volume) ; le processus tourne sous l'utilisateur `node` (non root).
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# Forme exec : node reçoit SIGTERM directement et exécute l'arrêt propre de server.js (webhooks, fermeture de la base).
CMD ["node", "src/server.js"]
