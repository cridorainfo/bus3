# Monorepo deploy: build context = repo root. The cloud app lives in cloud/.
# Railway reads /railway.toml and builds this image (GitHub deploys work without
# setting Root Directory in the dashboard). CLI alternative: railway up cloud --path-as-root

FROM node:22-alpine

# better-sqlite3 compiles native bindings at install time
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY cloud/package.json cloud/package-lock.json ./
RUN npm ci --omit=dev

COPY cloud/ ./

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
