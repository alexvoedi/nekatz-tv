FROM node:22-alpine AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV HUSKY=0

RUN corepack enable pnpm

# ---

FROM base AS build

ENV NODE_ENV=build

WORKDIR /app

COPY .npmrc package.json pnpm-workspace.yaml pnpm-lock.yaml ./

COPY apps/frontend/package.json apps/frontend/
COPY apps/backend/package.json apps/backend/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile

# ---

FROM build AS build-frontend

WORKDIR /app

ARG VITE_BACKEND_URL

ENV VITE_BACKEND_URL=$VITE_BACKEND_URL

COPY apps/backend ./apps/backend
COPY apps/frontend ./apps/frontend

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install \
  --frozen-lockfile \
  --no-scripts \
  --prefer-offline

RUN pnpm --filter=frontend build && pnpm deploy --filter=frontend --prod --no-optional /prod/frontend

# ---

FROM build AS build-backend

WORKDIR /app

COPY apps/backend ./apps/backend

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install \
  --frozen-lockfile \
  --filter=backend \
  --prefer-offline \
  --no-scripts

RUN pnpm --filter=backend build && pnpm deploy --filter=backend --prod --no-optional /prod/backend

# ---

FROM nginx:stable-alpine AS frontend

WORKDIR /usr/share/nginx/html

COPY --chown=nginx:nginx --chmod=755 --from=build-frontend /prod/frontend/dist .
COPY --chown=nginx:nginx --chmod=755 --from=build-frontend /prod/frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=5s --timeout=5s --start-period=5s --retries=5 CMD wget --no-verbose --tries=1 --spider http://0.0.0.0/ || exit 1


CMD ["nginx", "-g", "daemon off;"]

# ---

FROM node:22-alpine AS backend

# Install ffmpeg and VAAPI drivers for hardware acceleration
RUN apk add --no-cache \
    ffmpeg \
    intel-media-driver \
    libva-utils \
    mesa-va-gallium

WORKDIR /prod/backend

USER node

COPY --chown=node:node --chmod=755 --from=build-backend /prod/backend .

CMD ["node", "dist/index.js"]
