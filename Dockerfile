# Círculo — backend (CognitivoApiServer)
# Proceso Node persistente, 1 sola instancia, SQLite sobre volumen montado
# en /data. Sin cambios de arquitectura: exactamente `node bin/start-server.js`
# como corre local, solo empaquetado. Ver Project OS/DECISIONS.rtf, D-039.

FROM node:20-bullseye-slim

WORKDIR /app

# better-sqlite3 es nativo. Estas herramientas garantizan que compile igual
# si Northflank no tiene un binario prebuilt exacto para su arquitectura —
# sin esto, el build podría fallar de forma intermitente según el host.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY packages/cognitive-engine ./packages/cognitive-engine

ENV NODE_ENV=production
ENV CIRCULO_HOST=0.0.0.0

# El puerto real lo asigna Northflank vía PORT (bin/start-server.js ya lo
# respeta como fallback de CIRCULO_PORT) — este EXPOSE es documentación,
# no una restricción real.
EXPOSE 3000

CMD ["node", "packages/cognitive-engine/bin/start-server.js"]
