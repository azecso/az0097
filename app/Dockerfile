# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run lint && npm run build

# One-shot tooling image: migrations + one-time bootstrap (needs dev deps: tsx)
FROM deps AS tools
COPY . .
CMD ["npx", "tsx", "scripts/migrate.ts"]

FROM node:22-alpine AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 CHROMIUM_PATH=/usr/bin/chromium-browser HOME=/tmp
WORKDIR /app
# Chromium + Arabic fonts: server-side A4 PDF rendering (real Arabic shaping)
RUN apk add --no-cache chromium font-noto-arabic font-noto && addgroup -S app && adduser -S app -G app
RUN mkdir -p /data/uploads && chown app:app /data/uploads
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
