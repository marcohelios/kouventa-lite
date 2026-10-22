FROM node:20-slim

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3001

# tsx runs TS directly; swap for `node dist/server.js` once you add a build step
CMD ["npx", "tsx", "src/server.ts"]
