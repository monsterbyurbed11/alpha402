FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build && chown -R node:node /app

USER node

ENV PORT=8402

CMD ["node", "dist/mcp/server.js"]
