# Multi-stage build for whatsapp-mcp.
#
# Debian-based node image (not alpine): better-sqlite3 is a native module,
# and alpine's musl libc causes native-module build/runtime headaches.
# Both stages stay on the same glibc base so the build stage's compiled
# better-sqlite3 binary runs unmodified in the runtime stage.

# ---- build stage ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Build toolchain for native modules (better-sqlite3). Only needed here —
# never installed in the runtime stage below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies now, while still on the build-toolchain image, so
# the pruned node_modules (including the already-compiled better-sqlite3
# native binary) can be copied as-is into the lean runtime stage below.
RUN npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Documentation only (no EXPOSE-time behavior change): 8787 is the
# daemon's IPC TCP port (WHATSAPP_MCP_IPC_MODE=tcp), 8788 is the MCP
# server's HTTP transport port (WHATSAPP_MCP_TRANSPORT=http).
EXPOSE 8787 8788

# data/ (auth session, sqlite db, daemon/HTTP token files) is never baked
# into the image — gitignored and dockerignored on purpose. Mount it as a
# volume at runtime so it persists across container recreation. See
# README.md "Running in Docker".
VOLUME ["/app/data"]

# Defaults to the daemon: the long-running, stateful process that holds
# the WhatsApp connection and writes to SQLite. The MCP-server container
# built from this same image overrides this command to
# `node dist/mcp/index.js` instead — see README.md "Running in Docker".
CMD ["node", "dist/daemon/index.js"]
