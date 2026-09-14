FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --workspace @larynx/api --include-workspace-root=false
RUN npm run build --workspace @larynx/api

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
RUN npm ci --omit=dev --workspace @larynx/api --include-workspace-root=false --ignore-scripts \
    && npm cache clean --force
COPY --from=build /app/apps/api/dist ./apps/api/dist
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
