FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json tsconfig.json ./
RUN npm install
COPY . .

ENV DATABASE_URL="postgresql://user:pass@localhost:5432/db"
RUN npx prisma generate
RUN npx tsc

EXPOSE 3002
CMD ["node", "dist/server.js"]