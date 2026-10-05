# syntax=docker/dockerfile:1
# Pin companion to keep upstream changes from silently altering playback.
FROM quay.io/invidious/invidious-companion@sha256:63761efeecbcda4a9b581805259aedb991eae5ae033316dde31c1547aff29793 AS companion

FROM node:22-bookworm-slim AS frontend-builder
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY app/ ./
ENV VITE_SERVER_DOMAIN="" VITE_DONATION_URL="" BB_ADAPTER="staticadapter"
RUN npm exec svelte-kit sync && npm run build

FROM golang:1.27.1-bookworm AS backend-builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY backend/ ./backend/
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /beat-server .

FROM debian:13-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 ffmpeg tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin beatbump \
    && mkdir -p /app/config /data /downloads /var/tmp/youtubei.js \
    && chown -R beatbump:beatbump /app /data /downloads /var/tmp/youtubei.js
WORKDIR /app
COPY --from=companion /app/invidious_companion /app/invidious_companion
COPY --from=backend-builder /beat-server /app/beat-server
COPY --from=frontend-builder /app/build /app/build
COPY cloudflare/supervisor.py /app/supervisor.py
ENV BEATBUMP_DB_PATH=/data COMPANION_URL=http://127.0.0.1:8282 \
    HOST=127.0.0.1 PORT=8282 SERVER_BASE_PATH=/companion \
    CACHE_DIRECTORY=/var/tmp NETWORKING_FETCH_TIMEOUT_MS=30000 \
    PYTHONUNBUFFERED=1 BEATBUMP_CLOUDFLARE=true
USER beatbump
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "python3", "/app/supervisor.py"]
