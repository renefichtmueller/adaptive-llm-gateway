# ============================================================
# Stage 1: Builder
# ============================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json package-lock.json* ./
COPY packages/gateway/package.json ./packages/gateway/package.json

# Install all workspace dependencies
RUN npm install --workspace=packages/gateway

# Copy gateway source
COPY packages/gateway/ ./packages/gateway/

# Build TypeScript
RUN npm run build --workspace=packages/gateway

# ============================================================
# Stage 2: Runner
# ============================================================
FROM node:22-alpine AS runner

WORKDIR /app

# Security: run as non-root
RUN addgroup -S gateway && adduser -S gateway -G gateway

# Install wget for healthcheck (alpine has it by default, but be explicit)
RUN apk add --no-cache wget

# Copy compiled output
COPY --from=builder /app/packages/gateway/dist ./packages/gateway/dist

# Copy production node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/gateway/node_modules ./packages/gateway/node_modules 2>/dev/null || true

# Copy runtime assets (prompt templates, config)
COPY packages/gateway/prompts ./packages/gateway/prompts

# Copy start script
COPY packages/gateway/package.json ./packages/gateway/package.json
COPY package.json ./package.json

# Create log directory
RUN mkdir -p /var/log/llm-gateway && chown -R gateway:gateway /var/log/llm-gateway /app

USER gateway

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -q -O- http://localhost:3100/health/live || exit 1

CMD ["node", "packages/gateway/dist/server.js"]
