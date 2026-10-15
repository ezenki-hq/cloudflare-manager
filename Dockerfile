# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS frontend-build
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS backend-build
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
ARG GO_BUILD_PARALLELISM=1
WORKDIR /src/backend
COPY backend/go.mod ./
COPY backend/ ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    export CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH"; \
    if [ "$TARGETARCH" = "arm" ]; then export GOARM="${TARGETVARIANT#v}"; fi; \
    go build -p="$GO_BUILD_PARALLELISM" -trimpath -ldflags="-s -w" -o /out/cloudflare-manager ./cmd/cloudflare-manager

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=backend-build --chown=65532:65532 /out/cloudflare-manager /app/cloudflare-manager
COPY --from=frontend-build --chown=65532:65532 /src/frontend/dist /app/frontend/dist
ENV PORT=8080 STATIC_DIR=/app/frontend/dist
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/app/cloudflare-manager"]
