FROM node:22-alpine AS frontend-build
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ARG VITE_BACKEND_ORIGIN=
ARG VITE_BACKEND_IMAGE=
ARG VITE_RUNNER_IMAGE=
ARG VITE_CF_CLIENT_ID=
ARG VITE_PUBLIC_ORIGIN=
ARG VITE_COMMANDER_ORIGIN=
ENV VITE_BACKEND_ORIGIN=$VITE_BACKEND_ORIGIN \
    VITE_BACKEND_IMAGE=$VITE_BACKEND_IMAGE \
    VITE_RUNNER_IMAGE=$VITE_RUNNER_IMAGE \
    VITE_CF_CLIENT_ID=$VITE_CF_CLIENT_ID \
    VITE_PUBLIC_ORIGIN=$VITE_PUBLIC_ORIGIN \
    VITE_COMMANDER_ORIGIN=$VITE_COMMANDER_ORIGIN
RUN npm run build

FROM golang:1.25.0-alpine AS backend-build
WORKDIR /src
COPY backend/go.mod ./backend/go.mod
COPY backend/ ./backend/
WORKDIR /src/backend
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/cloudflare-manager ./cmd/cloudflare-manager

FROM gcr.io/distroless/static-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=backend-build --chown=65532:65532 /out/cloudflare-manager /app/cloudflare-manager
COPY --from=frontend-build --chown=65532:65532 /src/frontend/dist /app/frontend/dist
ENV PORT=8080 STATIC_DIR=/app/frontend/dist
EXPOSE 8080
ENTRYPOINT ["/app/cloudflare-manager"]

