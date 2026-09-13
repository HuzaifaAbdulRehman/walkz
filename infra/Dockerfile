FROM node@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS dependencies

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/git/package.json packages/git/package.json
COPY packages/github/package.json packages/github/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/sandbox/package.json packages/sandbox/package.json

RUN npm ci --ignore-scripts

FROM dependencies AS build

ARG WALKZ_SOURCE_REVISION=development

ENV NEXT_TELEMETRY_DISABLED=1 \
    WALKZ_SOURCE_REVISION="${WALKZ_SOURCE_REVISION}"

COPY . .

RUN npm run build && npm run build --workspace @walkz/web

FROM build AS migrate

CMD ["npm", "run", "migrate:up"]

FROM dependencies AS production-dependencies

RUN npm prune --omit=dev --ignore-scripts

FROM node@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runtime

WORKDIR /workspace
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

ARG WALKZ_SOURCE_REVISION=development
ARG WALKZ_VERSION=development

LABEL org.opencontainers.image.source="https://github.com/HuzaifaAbdulRehman/walkz" \
    org.opencontainers.image.revision="${WALKZ_SOURCE_REVISION}" \
    org.opencontainers.image.version="${WALKZ_VERSION}"

COPY --from=production-dependencies /workspace/node_modules ./node_modules
COPY --from=build /workspace/package.json /workspace/package-lock.json ./
COPY --from=build /workspace/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /workspace/packages/engine/package.json ./packages/engine/package.json
COPY --from=build /workspace/packages/engine/dist ./packages/engine/dist
COPY --from=build /workspace/packages/git/package.json ./packages/git/package.json
COPY --from=build /workspace/packages/git/dist ./packages/git/dist
COPY --from=build /workspace/packages/github/package.json ./packages/github/package.json
COPY --from=build /workspace/packages/github/dist ./packages/github/dist
COPY --from=build /workspace/packages/persistence/package.json ./packages/persistence/package.json
COPY --from=build /workspace/packages/persistence/dist ./packages/persistence/dist
COPY --from=build /workspace/packages/providers/package.json ./packages/providers/package.json
COPY --from=build /workspace/packages/providers/dist ./packages/providers/dist
COPY --from=build /workspace/packages/sandbox/package.json ./packages/sandbox/package.json
COPY --from=build /workspace/packages/sandbox/dist ./packages/sandbox/dist

USER 1000:1000

FROM runtime AS api

LABEL org.opencontainers.image.title="Walkz API" \
    io.walkz.service="api"

WORKDIR /workspace/apps/api
COPY --from=build /workspace/apps/api/package.json ./package.json
COPY --from=build /workspace/apps/api/dist ./dist
EXPOSE 3001
CMD ["node", "dist/bin.js"]

FROM runtime AS web

LABEL org.opencontainers.image.title="Walkz Web" \
    io.walkz.service="web"

WORKDIR /workspace/apps/web
COPY --from=build /workspace/apps/web/package.json ./package.json
COPY --from=build /workspace/apps/web/.next ./.next
EXPOSE 3000
CMD ["node", "../../node_modules/next/dist/bin/next", "start"]

FROM runtime AS worker

LABEL org.opencontainers.image.title="Walkz Worker" \
    io.walkz.service="worker"

USER root
RUN apk add --no-cache git=2.54.0-r0 ca-certificates=20260611-r0 docker-cli=29.5.3-r1 \
    && mkdir -p /var/lib/walkz/proof \
    && chown -R 1000:1000 /var/lib/walkz
USER 1000:1000

WORKDIR /workspace/apps/worker
COPY --from=build /workspace/apps/worker/package.json ./package.json
COPY --from=build /workspace/apps/worker/dist ./dist
CMD ["node", "dist/bin.js"]
