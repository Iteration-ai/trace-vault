FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/cli/package.json packages/cli/package.json
COPY packages/trace-contracts packages/trace-contracts
COPY packages/vault packages/vault
COPY src/shared/ui src/shared/ui
COPY src/shared/contracts src/shared/contracts
COPY src/app/globals.css src/app/globals.css
RUN pnpm install --frozen-lockfile && pnpm --filter trace-vault build
RUN pnpm --filter trace-vault --prod deploy --legacy /output

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
ENV NODE_ENV=production VAULT_HOST=0.0.0.0 VAULT_PORT=4310
WORKDIR /app
COPY --from=build --chown=node:node /output /app
USER node
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["node", "-e", "fetch('http://127.0.0.1:4310/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
