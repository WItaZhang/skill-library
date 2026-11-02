# Build ONLY from the complete, reviewed merged repository: no private branch overlays.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY src ./src
RUN sh src/deployment/install.sh
RUN npm run build --prefix src/modules/product \
 && npm run typecheck --prefix src/modules/operations \
 && src/modules/product/node_modules/.bin/tsc -p src/integration/production-tsconfig.json

FROM node:24-bookworm-slim AS production
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# Copy source without builder node_modules; install the committed runtime lockfiles only.
COPY src ./src
RUN for module in product identity persistence execution operations broadcast service runtime web; do \
      npm ci --omit=dev --prefix "src/modules/$module" --no-audit --no-fund || exit 1; \
    done \
 && ln -s modules/product/node_modules src/node_modules \
 && npm cache clean --force
COPY --from=build /app/src/modules/product/dist ./src/modules/product/dist
ARG RELEASE_SHA=unknown
ENV RELEASE_SHA=$RELEASE_SHA
USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node src/deployment/healthcheck.ts
CMD ["node", "src/integration/production-start.ts"]
