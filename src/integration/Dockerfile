FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY src/modules/web/package*.json src/modules/web/
RUN npm ci --prefix src/modules/web
COPY src src
RUN ln -s modules/web/node_modules src/node_modules
RUN npm ci --prefix src/modules/service --omit=dev
RUN npm run build --prefix src/modules/web

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
COPY --from=build /app/src/contracts /app/src/contracts
COPY --from=build /app/src/modules /app/src/modules
COPY --from=build /app/src/integration /app/src/integration
COPY --from=build /app/src/package.json /app/src/package.json
RUN rm -rf /app/src/modules/web/node_modules
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "src/integration/start.ts"]
