FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json nest-cli.json ./
COPY src/ src/
RUN npm run build

FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
# npm is only needed to install: the running service has no use for it
# (nor for its bundled dependencies, a recurring source of CVEs).
RUN npm ci --omit=dev && npm cache clean --force \n    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=builder /app/dist ./dist

EXPOSE 8084
USER node

CMD ["node", "dist/main.js"]
