FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src/ src/

ENV PORT=8080
EXPOSE 8080

CMD ["npx", "tsx", "src/server.ts"]
