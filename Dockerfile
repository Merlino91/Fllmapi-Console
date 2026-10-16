FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY fallback-config.json ./
COPY patch/ ./patch/
COPY public/ ./public/
EXPOSE 3002
CMD ["node", "server.js"]
