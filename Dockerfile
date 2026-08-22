FROM node:20-alpine

ENV NODE_ENV=production \
    # Listen on all interfaces inside the container
    GCA_BIND=0.0.0.0 \
    GCA_CONFIG=/app/config/config.json \
    GCA_CACHE_DIR=/app/cache

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY config/config.example.json config/config.example.json

# Runway geometry discovered from DCS is cached here; mount a volume to keep it
# across container recreates. The directory is created up front so a named
# volume inherits the 'node' ownership instead of landing root-owned.
RUN mkdir -p /app/cache && chown -R node:node /app/cache /app/config

# Run as the non-root 'node' user bundled with the base image
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GCA_PORT||8080)+'/api/config').then(r=>{if(!r.ok)throw 0}).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
