# ============================================
# Stage 1: Node.js runtime (copied into the Python image below)
# ============================================
FROM node:22-bookworm-slim AS node-runtime

# ============================================
# Stage 2: Base - Python + Node.js runtime
# ============================================
# The panorama worker is Python/OpenCV, so start from the official Python
# image and add Node from the official Node image.  No apt mirror is needed,
# and the packages are installed into the same interpreter that runs them.
FROM python:3.11-slim AS base

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    useradd --uid 1000 --create-home --shell /bin/sh node && \
    node --version && npm --version

COPY requirements-panorama.txt /tmp/requirements-panorama.txt
RUN pip install --no-cache-dir -r /tmp/requirements-panorama.txt && \
    rm /tmp/requirements-panorama.txt && \
    python3 -c "import cv2, numpy; print('OpenCV', cv2.__version__)"

WORKDIR /app

# Captured rooms and test cases live outside the image, in folders that are
# bind-mounted from the host (see docker-compose*.yml), so rebuilding or
# recreating the container never deletes photos.
ENV ASTRA3D_DATA_DIR=/app/.astra3d-data \
    ASTRA3D_TEST_CASES_DIR=/app/test-cases \
    NEXT_TELEMETRY_DISABLED=1

# ============================================
# Stage 3: Development
# ============================================
FROM base AS dev

# Install Node dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Install panorama ML models (optional)
RUN python3 scripts/download-panorama-models.py || true

EXPOSE 3000

ENV NODE_ENV=development

# Start with hot reload enabled
CMD ["npm", "run", "dev"]

# ============================================
# Stage 4: Production build
# ============================================
FROM base AS builder

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

# ============================================
# Stage 5: Production runtime
# ============================================
FROM base AS production

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./next.config.ts
# The OpenCV stitcher is spawned from scripts/ at runtime.
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/test-cases ./test-cases
COPY scripts/docker-entrypoint.sh /usr/local/bin/astra3d-entrypoint

# Optional learned matcher for bare walls; the stitcher works without it.
RUN python3 scripts/download-panorama-models.py || true

RUN chmod 755 /usr/local/bin/astra3d-entrypoint && \
    mkdir -p .astra3d-data && \
    chown -R node:node .astra3d-data test-cases .next

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/panorama').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Starts as root only to make bind-mounted folders writable, then runs the
# server as the unprivileged `node` user.
ENTRYPOINT ["astra3d-entrypoint"]
CMD ["npm", "run", "start"]
