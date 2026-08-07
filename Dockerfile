FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run postinstall && npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app/.output
COPY --from=build /app/.output ./
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts/migrate.mjs ./server/migrate.mjs
# Nitro traces dependencies used by the app, but migrate.mjs is copied after
# the build and its two migration-only modules must be included explicitly.
COPY --from=build /app/node_modules/drizzle-orm/migrator.js ./server/node_modules/drizzle-orm/migrator.js
COPY --from=build /app/node_modules/drizzle-orm/postgres-js/migrator.js ./server/node_modules/drizzle-orm/postgres-js/migrator.js
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node server/migrate.mjs && exec node server/index.mjs"]
