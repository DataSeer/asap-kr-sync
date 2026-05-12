# Stage 1: Install all dependencies (Debian base for libc compatibility with final stage)
# Using node:20-slim instead of node:20-alpine so the native modules built
# here (e.g. bcrypt) link against glibc and can be reused as-is in stage 3.
# This eliminates the second `npm ci` that previously ran in the final stage —
# halves total build time and removes the network-flakiness failure mode.
FROM node:20-slim AS deps

WORKDIR /app

# Build deps for native modules (bcrypt). Only needed in this stage —
# nothing under /app/node_modules carries them, and the final stage starts
# from a clean node:20-slim.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy root workspace config and lockfile
COPY package.json package-lock.json ./

# Copy workspace package.json files (needed for npm ci to resolve workspaces)
COPY src/frontend/package.json src/frontend/
COPY src/backend/package.json src/backend/

# Install all dependencies from lockfile (deterministic, reproducible).
# Includes devDependencies — vite is needed by stage 2, and the final image
# also runs in dev mode (nodemon, etc.) for the dev systemd unit.
RUN npm ci

# Stage 2: Build frontend
FROM deps AS build

COPY src/frontend/ src/frontend/
RUN cd src/frontend && npm run build

# Stage 3: Final image (used for localhost, dev, and production)
# Same node:20-slim base as deps so the copied node_modules works without
# rebuild. glibc gives us reliable manylinux wheels for ML deps
# (onnxruntime via markitdown -> magika), which Alpine/musl lacks.
FROM node:20-slim

# System runtime dependencies: PostgreSQL client + Python 3 + pip
# (for langextract + markitdown). No build-essential — node_modules
# arrives pre-built from the deps stage.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        postgresql-client \
        python3 \
        python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bring fully-installed node_modules + workspace package.json files from
# the deps stage. Skips the second `npm ci` (slow + network-flaky) and
# avoids needing build-essential in the final image.
COPY --from=deps /app/ /app/

# Copy backend source (overlays src/backend/, leaves node_modules intact)
COPY src/backend/ src/backend/

# Copy project-level files needed at runtime
COPY conf/ conf/
COPY migrations/ migrations/
COPY seeders/ seeders/
COPY scripts/ scripts/

# Install Python dependencies for langextract (datasets/materials/protocols signal extraction)
RUN pip3 install --break-system-packages -r src/backend/python/requirements.txt

# Copy built frontend from build stage
COPY --from=build /app/src/frontend/dist/ src/frontend/dist/

# Copy frontend source (needed for localhost dev server)
COPY src/frontend/ src/frontend/

# Copy entrypoint and fix line endings (CRLF -> LF)
COPY deploy/docker-entrypoint.sh /docker-entrypoint.sh
RUN sed -i 's/\r$//' /docker-entrypoint.sh && chmod +x /docker-entrypoint.sh

# Create non-root user and ensure runtime-writable directories exist with
# correct ownership. logs/ is written to by winston in production; /home/app
# gives npm/npx a cache dir for the entrypoint's sequelize-cli migration step.
RUN groupadd --system app \
    && useradd --system --gid app --create-home --home-dir /home/app --shell /bin/false app \
    && mkdir -p /app/logs \
    && chown -R app:app /app /home/app

USER app

EXPOSE 3000 5173

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "src/backend/server.js"]
