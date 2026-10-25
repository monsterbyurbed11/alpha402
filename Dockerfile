FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV PORT=8402

CMD ["npx", "tsx", "src/mcp/server.ts"]
