FROM node:26.7.0-bookworm-slim
ENV NODE_ENV=production DSH_HOME=/state/harness DSH_TELEMETRY_DISABLED=1
WORKDIR /opt/astral/deploy/dsh
COPY deploy/dsh/package.json deploy/dsh/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY deploy/dsh ./
COPY integrations/dsh-app-tools /opt/astral/integrations/dsh-app-tools
# The plugin resolves the same fixed native SDK as the managed profile.
RUN ln -s /opt/astral/deploy/dsh/node_modules /opt/astral/integrations/dsh-app-tools/node_modules
# /tmp remains noexec. Load verified installed bindings instead of copying them
# into that temporary filesystem and attempting dlopen from there.
ENV NARB_DISABLE_NATIVE_CACHE=1 ASTRAL_DSH_WORKSPACE=/workspace
USER node
WORKDIR /workspace
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=3 CMD node -e "fetch('http://127.0.0.1:8972/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/opt/astral/deploy/dsh/host.mjs"]
