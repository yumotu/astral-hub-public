# Pi 官网推荐的官方 npm 包；固定版本，禁用安装脚本。
FROM node:26.7.0-alpine
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.4.0 && npm cache clean --force
WORKDIR /extensions
COPY extensions/package.json extensions/package-lock.json ./
RUN npm ci --ignore-scripts --legacy-peer-deps --omit=dev && mkdir -p node_modules/@earendil-works && ln -s /usr/local/lib/node_modules/@earendil-works/pi-coding-agent node_modules/@earendil-works/pi-coding-agent && ln -s /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai node_modules/@earendil-works/pi-ai && ln -s /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui node_modules/@earendil-works/pi-tui && ln -s /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox node_modules/typebox && npm cache clean --force
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories && apk add --no-cache --virtual .pty-build python3 make g++ && node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --directory=/extensions/node_modules/node-pty --nodedir=/usr/local && apk del .pty-build
RUN apk add --no-cache bash bubblewrap python3 py3-pip py3-virtualenv ca-certificates curl git ripgrep fd
WORKDIR /bridge
COPY --chown=node:node bridge.mjs models.json project-files.mjs file-diff.mjs project-tools.mjs protocol.mjs projects.json projects.mjs rpc-worker.mjs skill-tools.mjs skill-store.mjs skill-install.mjs skill-command.mjs bash-tools.mjs bash-sandbox.mjs thinking.mjs chat-tools.mjs web-tools.mjs web-search.json attachments.mjs package-tools.mjs package-resources.mjs provider-error.mjs ./
COPY --chown=node:node rpc-prompt.mjs cron-ledger.mjs cron-host.mjs cron-service.mjs cron-tools.mjs native-cron.mjs model-context.mjs ./
COPY --chown=node:node notification-tools.mjs notification-protocol.mjs ./
COPY --chown=node:node terminal-runtime.mjs host-tools.mjs ./
COPY --chown=node:node plugin-load-plan.mjs runtime-diagnostics.mjs package-transaction.mjs package-preflight.mjs ./
COPY --chown=node:node rpc-startup.mjs ./
COPY --chown=node:node stream-writer.mjs ./
COPY --chown=node:node activity-deadline.mjs ask-user.mjs ./
COPY --chown=node:node question-continuation.mjs ./
COPY --chown=node:node long-goal.mjs ./
COPY --chown=node:node long-goal-command.mjs ./
COPY --chown=node:node schedule-tools.mjs cron-scope.mjs ./
COPY --chown=node:node vendor/ vendor/
COPY --chown=node:node office-content.mjs document-text.mjs ./
COPY --chown=node:node pdf-content.mjs pdf-document.mjs chat-content.mjs ./
COPY --chown=node:node attachment-limits.mjs ./
COPY --chown=node:node usage-telemetry.mjs ./
COPY --chown=node:node skill-catalog.mjs run-pool.mjs project-lock.mjs concurrency.mjs ./
COPY --chown=node:node session-fork.mjs goal-command.mjs goal-tools.mjs steer-controls.mjs ./
COPY --chown=node:node bash-network.mjs ./
COPY --chown=node:node mail-tools.mjs app-tools.mjs ./
COPY --chown=node:node verify-runtime.mjs ./
COPY --chown=node:node verify-schedules.mjs ./
COPY --chown=node:node verify-documents.mjs qa-ocr.jpg qa-scanned-pdf.mjs ./
RUN ln -s /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules /bridge/node_modules && mkdir -p /uploads /workspace /home/node/.pi/agent /projects/astral-hub /projects/workspace /projects/server-workspace && chown -R node:node /uploads /workspace /home/node/.pi /projects
USER node
ENV PI_CODING_AGENT_DIR=/home/node/.pi/agent PI_OFFLINE=1 NODE_OPTIONS=--max-old-space-size=384
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:8790/health',{headers:{Authorization:'Bearer '+process.env.PI_BRIDGE_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bridge.mjs"]
