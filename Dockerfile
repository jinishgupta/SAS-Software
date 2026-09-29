# SAS: one image serving the API and the frontend. node:sqlite needs Node 22.13+.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    SAS_DB=/data/sas.db \
    FRONTEND_DIR=/app/frontend

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY backend/ ./
COPY frontend/ /app/frontend/
# Same-origin API when served by the backend
RUN echo "window.SAS_API = '/api';" > /app/frontend/config.js \
 && rm -f /app/frontend/server.js /app/frontend/package.json \
 && mkdir -p /data && chown -R node:node /data /app

USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/ >/dev/null || exit 1

CMD ["node", "--no-warnings", "server.js"]
