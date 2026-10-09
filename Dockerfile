# One image definition for both services (npm workspaces share one lockfile).
#   docker build --target api -t radcore-api .
#   docker build --target web -t radcore-web .
# compose.prod.yml builds both; see "Run it on a server" in README.md.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node apps/api/package.json apps/api/
COPY --chown=node:node apps/web/package.json apps/web/
COPY --chown=node:node packages/shared/package.json packages/shared/
RUN npm ci
COPY --chown=node:node tsconfig.base.json ./
COPY --chown=node:node packages/shared packages/shared

# ---- API: Express + TypeScript, run with tsx. Applies database migrations on start. ----
FROM deps AS api
COPY --chown=node:node apps/api apps/api
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start", "-w", "@radcore/api"]

# ---- Web: Next.js production build ----
FROM deps AS web
COPY --chown=node:node apps/web apps/web
# Only used by the dev-style /api proxy inside Next; in production the reverse proxy sends /api straight to the API.
ARG API_URL=http://api:4000
ENV API_URL=$API_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @radcore/web
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3   CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start", "-w", "@radcore/web"]
