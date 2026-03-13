FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3017

CMD ["node", "--max-old-space-size=96", "src/server.js"]
