# The lighting plugin service — plain ESM node, one dependency (mqtt.js).
# Deliberately standalone: NOT part of the pnpm workspace, so the plugin
# folder is self-contained and buildable on any host (appliance included).
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
ENV NODE_ENV=production
USER node
CMD ["node", "src/index.mjs"]
