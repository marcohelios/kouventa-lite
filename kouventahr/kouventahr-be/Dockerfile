FROM node:20-slim

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# Prisma needs the schema present before generate
COPY prisma ./prisma
COPY prisma.config.ts ./

# prisma.config.ts resolves DATABASE_URL eagerly, even just to generate
# the client. The real value comes from docker-compose at runtime —
# this placeholder only needs to exist so generate doesn't fail the build.
ARG DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
ENV DATABASE_URL=${DATABASE_URL}
RUN npx prisma generate

COPY . .

EXPOSE 3001

# tsx runs TS directly; swap for `node dist/server.js` once you add a build step
CMD ["npx", "tsx", "server.ts"]