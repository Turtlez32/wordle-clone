FROM oven/bun:1 AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
WORKDIR /app

COPY . .
RUN bun run build

FROM oven/bun:1 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/dist ./dist
COPY --from=build /app/server.ts ./server.ts

EXPOSE 3001

CMD ["bun", "run", "start"]
