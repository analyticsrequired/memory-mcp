FROM node:24-alpine AS builder

WORKDIR /app

# Install dependencies first so this layer is cached until the manifests change.
# --ignore-scripts skips the "prepare" hook (which runs the build) because the
# sources have not been copied yet; the build is run explicitly below.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS release

ENV NODE_ENV=production

WORKDIR /app

# Production dependencies only; the compiled server needs package.json at
# runtime too (src/version.ts reads the version from it).
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --omit=dev

COPY --from=builder /app/dist ./dist

ENTRYPOINT ["node", "dist/index.js"]
