# 基镜像策略：node:22.19.x-slim，tag 锁补丁版本（HLD §6；digest 锚定在首次构建后补记）
FROM node:22.19-slim AS base
ENV PNPM_HOME=/pnpm
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile || pnpm install

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @msf/shared build && pnpm --filter @msf/server build

FROM node:22.19-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/shared /app/packages/shared
COPY --from=build /app/apps/server/dist /app/apps/server/dist
COPY --from=build /app/apps/server/package.json /app/apps/server/
EXPOSE 8080
CMD ["node", "apps/server/dist/main.js"]
