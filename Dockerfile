FROM node:20-alpine

ENV NODE_ENV=production
# Listen on all interfaces inside the container
ENV GCA_BIND=0.0.0.0

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY config/config.example.json config/config.example.json

# Run as the non-root 'node' user bundled with the base image
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/config').then(r=>{if(!r.ok)throw 0}).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
