FROM node:22-alpine AS build
WORKDIR /workspace
COPY package*.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY services/pipeline/package.json services/pipeline/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --ignore-scripts
COPY apps/api apps/api
RUN npm run build -w @obbian/api && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine
# Runtime only executes node; omit package-manager toolchains and their attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /workspace/node_modules node_modules
COPY --from=build --chown=node:node /workspace/apps/api/dist dist
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
