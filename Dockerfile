FROM node:24-bookworm-slim as base

USER node
ENV HOME=/home/node
WORKDIR $HOME/app

FROM base as builder

ADD package.json package-lock.json $HOME/app/

RUN npm ci

COPY . $HOME/app/

RUN npm run flow
RUN npm run build

FROM base as prod

ENV NODE_ENV=production

COPY package.json package-lock.json $HOME/app/

RUN npm ci

COPY --from=builder $HOME/app/build $HOME/app/

CMD ["node", "app.js"]
