# ============================================
# Stage 1: Python dependencies (for panorama processing)
# ============================================
FROM python:3.11-slim AS python-deps

WORKDIR /app

COPY requirements-panorama.txt .

RUN pip install --no-cache-dir -r requirements-panorama.txt

# ============================================
# Stage 2: Base - Node.js + Python runtime
# ============================================
FROM node:20-alpine AS base

# Install Python for panorama processing
RUN apk add --no-cache python3 py3-pip

# Copy Python dependencies from Stage 1
COPY --from=python-deps /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=python-deps /usr/local/bin /usr/local/bin

WORKDIR /app

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
RUN python scripts/download-panorama-models.py || true

# Expose port
EXPOSE 3000

# Environment
ENV NODE_ENV=development
ENV ASTRA3D_DATA_DIR=/app/.astra3d-data

# Volume for hot reload and project data
VOLUME ["/app/.astra3d-data"]

# Start with hot reload enabled
CMD ["npm", "run", "dev"]

# ============================================
# Stage 4: Production build
# ============================================
FROM base AS builder

# Install Node dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Build Next.js application
RUN npm run build

# ============================================
# Stage 5: Production runtime
# ============================================
FROM base AS production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

# Set working directory
WORKDIR /app

# Install production Node dependencies
COPY package*.json ./
RUN npm ci --production

# Copy built application from builder
COPY --from=builder /app/.next .next
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src

# Install panorama ML models
RUN python scripts/download-panorama-models.py || true

# Create data directory with correct permissions
RUN mkdir -p .astra3d-data && chown -R nextjs:nodejs .astra3d-data

# Expose port
EXPOSE 3000

# Environment
ENV NODE_ENV=production
ENV ASTRA3D_DATA_DIR=/app/.astra3d-data

# User should be nextjs, but panorama scripts run as subprocess need python
# So we stay as root for python access, or use node to spawn

# Start production server
USER nodejs
CMD ["npm", "run", "start"]
