# CaptionVAR live: one container serves the site and runs the agents.
#   site     the Vite build (dist/), the same build as GitHub Pages
#   agents   Python, Microsoft Agent Framework (agents/live_server.py)
#   referee  Node.js, scripts/referee-mcp.mjs, spawned by the agents over MCP
# No keys: on Azure Container Apps the agents sign in with the app's managed identity.

FROM node:22-slim AS site
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
COPY docs/demo-adjudication.json ./docs/demo-adjudication.json
RUN npm run build

FROM node:22-slim AS referee-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 HOST=0.0.0.0 PORT=8000
COPY --from=site /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY agents/requirements.txt agents/requirements.txt
RUN pip install -r agents/requirements.txt
COPY --from=referee-deps /app/node_modules ./node_modules
COPY package.json ./
COPY scripts ./scripts
COPY src/sim ./src/sim
COPY src/broadcast ./src/broadcast
COPY agents ./agents
COPY --from=site /app/dist ./dist
RUN useradd --create-home --uid 10001 captionvar && node --version
USER captionvar
EXPOSE 8000
CMD ["python", "agents/live_server.py"]
