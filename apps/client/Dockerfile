FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/client/package.json apps/client/package.json
COPY apps/api/package.json apps/api/package.json
COPY vendor vendor
RUN npm ci
COPY apps/client apps/client
ARG EXPO_PUBLIC_API_ORIGIN=http://localhost:3000
ENV EXPO_PUBLIC_API_ORIGIN=$EXPO_PUBLIC_API_ORIGIN
RUN npm run build:web --workspace @larynx/client

FROM nginx:1.28-alpine AS runtime
COPY apps/client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/client/dist /usr/share/nginx/html
EXPOSE 8080
