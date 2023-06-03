FROM node:18.14.2-bullseye-slim

WORKDIR /bot
COPY ./package.json ./
COPY ./package-lock.json ./
COPY ./tsconfig.json ./
RUN mkdir src

WORKDIR /bot/src
COPY ../../src ./

WORKDIR /bot

RUN npm install
RUN npm run build

CMD [ "node", "dist/index.js" ]