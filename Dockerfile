FROM node:10.15.0-alpine

ENV HOME=/home/node
ENV NODE_ENV=production

WORKDIR $HOME/app

ADD package.json package-lock.json $HOME/app/

RUN npm install

COPY src $HOME/app/

RUN chown -R node:node $HOME/app

USER node

CMD ["node", "app.js"]
