FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY fallback-config.json ./
COPY public/ ./public/
EXPOSE 3002
CMD ["node", "--experimental-sqlite", "server.js"]
