# Multi-stage build. One image runs as the API or the worker (WORKER_ENABLED); a separate target
# applies database migrations. Pinned to the Node version CI uses, by digest: the multi-arch index, so
# the same image is used on every machine until Dependabot proposes a new one.

# --- build: all dependencies, Prisma client generation, TypeScript compile ---
FROM node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Prisma's postinstall needs the schema to generate the client.
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
# Compiles src/ (including the generated client in src/generated) into dist/.
RUN npm run build

# --- migrate: runs `prisma migrate deploy` once, then exits (docker compose service "migrate") ---
# Uses the build stage because the Prisma CLI is a dev dependency, kept out of the runtime image.
FROM build AS migrate
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

# --- runtime: production dependencies and compiled code only ---
FROM node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the postinstall (`prisma generate`) needs the dev-only Prisma CLI and isn't
# needed here, because the client was generated and compiled into dist/ in the build stage.
# --omit=optional: the Prisma CLI is a dev dependency but also an optional peer of @prisma/client,
# so npm marks it "devOptional" and keeps it unless optional packages are omitted too. Without
# this the CLI and its dependencies (with 4 high audit findings) would ship. The only other optional
# packages are BullMQ's native msgpack speed-up, which falls back to plain JavaScript.
# npm itself goes afterwards: the app never runs it, and the copy bundled with Node is where the image
# scan finds vulnerabilities (stage 10).
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /app/dist ./dist
# Served by the app as the checkout pages (src/app.setup.ts resolves ../public from dist/).
COPY public ./public
USER node
EXPOSE 3000
# Readiness: 200 only when the database answers (src/health).
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/health" || exit 1
CMD ["node", "dist/main.js"]
