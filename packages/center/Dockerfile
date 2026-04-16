FROM node:22-alpine AS build

# Install build tools for better-sqlite3 native addon
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy shared package (built)
COPY packages/shared/package.json packages/shared/
COPY packages/shared/dist/ packages/shared/dist/

# Copy center package (built)
COPY packages/center/dist/ packages/center/dist/

# Create a Docker-safe package.json (replace workspace: with file:)
RUN echo '{ \
  "name": "@flow-a2a/center", \
  "type": "module", \
  "dependencies": { \
    "@flow-a2a/shared": "file:../shared", \
    "better-sqlite3": "^9.4.3", \
    "graphql": "^16.13.0", \
    "graphql-yoga": "^5.21.0", \
    "ioredis": "^5.4.0", \
    "pg": "^8.13.0", \
    "prom-client": "^15.1.0", \
    "ws": "^8.18.0" \
  } \
}' > packages/center/package.json

RUN cd packages/center && npm install --omit=dev

# Runtime stage (no build tools)
FROM node:22-alpine

WORKDIR /app
COPY --from=build /app /app

ENV WS_PORT=9876
ENV HTTP_PORT=3000
ENV DB_PATH=/data/flow-a2a-center.db

EXPOSE 9876 3000

CMD ["node", "packages/center/dist/index.js"]
