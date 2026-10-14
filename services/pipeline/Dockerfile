FROM node:22-alpine AS build
WORKDIR /workspace
COPY package*.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY services/pipeline/package.json services/pipeline/package.json
RUN npm ci --ignore-scripts
COPY packages/contracts packages/contracts
COPY services/pipeline services/pipeline
RUN npm run build -w @obbian/contracts && npm run build -w @obbian/pipeline && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine
# Runtime only executes node; omit package-manager toolchains and their attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production
USER node
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/node_modules node_modules
COPY --from=build --chown=node:node /workspace/packages/contracts/dist packages/contracts/dist
COPY --from=build --chown=node:node /workspace/packages/contracts/package.json packages/contracts/package.json
COPY --from=build --chown=node:node /workspace/services/pipeline/dist services/pipeline/dist
COPY --from=build --chown=node:node /workspace/services/pipeline/package.json services/pipeline/package.json
CMD ["node", "services/pipeline/dist/index.js"]
