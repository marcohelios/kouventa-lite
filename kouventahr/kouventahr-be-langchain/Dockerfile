FROM node:20-slim

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json ./
# --legacy-peer-deps: @langchain/community declares @browserbasehq/stagehand as a peer, which wants
# zod@3 while this project uses zod@4. Newer npm tolerates it; the npm in node:20 does not.
RUN npm ci --legacy-peer-deps

COPY . .

EXPOSE 3001

# tsx runs TS directly; swap for `node dist/server.js` once you add a build step
CMD ["npx", "tsx", "src/server.ts"]
