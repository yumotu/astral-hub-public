FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/app/data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/deploy/pi/concurrency.mjs ./deploy/pi/concurrency.mjs
COPY --from=build --chown=node:node /app/deploy/pi/attachment-limits.mjs ./deploy/pi/attachment-limits.mjs
COPY --from=build --chown=node:node /app/deploy/pi/activity-deadline.mjs ./deploy/pi/activity-deadline.mjs
COPY --from=build --chown=node:node /app/deploy/pi/long-goal-command.mjs ./deploy/pi/long-goal-command.mjs
COPY --from=build --chown=node:node /app/deploy/pi/goal-plan.mjs ./deploy/pi/goal-plan.mjs
COPY --from=build --chown=node:node /app/deploy/pi/question-continuation.mjs ./deploy/pi/question-continuation.mjs
COPY --from=build --chown=node:node /app/deploy/pi/chat-content.mjs /app/deploy/pi/document-text.mjs /app/deploy/pi/office-content.mjs /app/deploy/pi/pdf-document.mjs /app/deploy/pi/pdf-content.mjs /app/deploy/pi/attachments.mjs ./deploy/pi/
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir data files && chown node:node data files
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
