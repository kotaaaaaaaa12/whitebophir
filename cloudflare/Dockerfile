FROM node:24-alpine
WORKDIR /opt/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node server ./server
COPY --chown=node:node client-data ./client-data
COPY --chown=node:node types ./types
COPY --chown=node:node cloudflare/entrypoint.mjs ./cloudflare/entrypoint.mjs
RUN mkdir -p server-data && chown node:node server-data
USER node
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
EXPOSE 8080
CMD ["node", "cloudflare/entrypoint.mjs"]
