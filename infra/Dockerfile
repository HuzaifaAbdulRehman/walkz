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
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/sandbox/package.json packages/sandbox/package.json

RUN npm ci --ignore-scripts

FROM dependencies AS build

COPY . .

RUN npm run build && npm run build --workspace @walkz/web

FROM build AS migrate

CMD ["npm", "run", "migrate:up"]

FROM node@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runtime

WORKDIR /workspace
ENV NODE_ENV=production

COPY --from=dependencies /workspace/node_modules ./node_modules
COPY --from=build /workspace/package.json /workspace/package-lock.json ./
COPY --from=build /workspace/apps ./apps
COPY --from=build /workspace/packages ./packages

USER 1000:1000

FROM runtime AS api

WORKDIR /workspace/apps/api
EXPOSE 3001
CMD ["node", "dist/bin.js"]

FROM runtime AS web

WORKDIR /workspace/apps/web
EXPOSE 3000
CMD ["node", "../../node_modules/next/dist/bin/next", "start"]

FROM runtime AS worker

USER root
RUN apk add --no-cache git ca-certificates
USER 1000:1000

WORKDIR /workspace/apps/worker
CMD ["node", "dist/bin.js"]
