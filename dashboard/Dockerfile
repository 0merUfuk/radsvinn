# mercury-dashboard — the public BFF over the private Mercury planner.
# Zero runtime npm dependencies (node:http/crypto/fs only), so this is a
# single-stage node:22-slim image with just the source copied in. It is a
# SEPARATE Railway service from the planner and shares no volume with it
# (invariant 6/12): disk-stateless, sessions in memory.
FROM node:22-slim

WORKDIR /app

# No dependency install step — package.json declares zero runtime deps by
# design. Copying it anyway keeps `npm_package_version` populated for /healthz.
COPY package.json ./
COPY lib ./lib
COPY public ./public
COPY server.mjs ./

# Public BFF: binds :: on Railway's injected $PORT (edge TLS terminates in
# front). No volume mount. Fails closed on missing config (see server.mjs boot()).
ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.mjs"]
