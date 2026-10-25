FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts && chown -R node:node /app

COPY --chown=node:node . .

USER node

ENV PORT=8402

CMD ["npx", "tsx", "src/mcp/server.ts"]
