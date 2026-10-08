# check=skip=FromPlatformFlagConstDisallowed
# Multi-architecture image (linux/amd64, linux/arm64). Both stages that run commands use the build
# machine's amd64: flow-bin 0.92 only ships an x64 binary, and node_modules is pure JavaScript, so one
# install serves every target and the final stage needs no emulation. Building on an arm64 machine
# therefore runs those two stages under emulation.
#   docker buildx build --platform linux/amd64,linux/arm64 .

FROM --platform=linux/amd64 node:24-bookworm-slim AS builder

USER node
ENV HOME=/home/node
WORKDIR $HOME/app

ADD package.json package-lock.json $HOME/app/

RUN npm ci

COPY . $HOME/app/

RUN npm run flow
RUN npm run build

FROM --platform=linux/amd64 node:24-bookworm-slim AS deps

USER node
ENV HOME=/home/node
WORKDIR $HOME/app

ENV NODE_ENV=production

COPY package.json package-lock.json $HOME/app/

RUN npm ci

# A native addon would be built for amd64 here and break on the other architectures.
RUN if find node_modules \( -name '*.node' -o -name binding.gyp \) | grep -q .; then \
      echo 'node_modules contains a native addon: it cannot be shared across architectures' >&2; exit 1; \
    fi

FROM node:24-bookworm-slim AS prod

USER node
ENV HOME=/home/node
WORKDIR $HOME/app

ENV NODE_ENV=production

COPY --from=deps $HOME/app/node_modules $HOME/app/node_modules
COPY --from=builder $HOME/app/build $HOME/app/

CMD ["node", "app.js"]
