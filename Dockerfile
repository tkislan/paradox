FROM node:10.15.0-alpine

ENV HOME=/home/node
ENV NODE_ENV=production

WORKDIR $HOME/app

ADD package.json yarn.lock $HOME/app/

RUN yarn install

COPY src $HOME/app/

RUN chown -R node:node $HOME/app

USER node
