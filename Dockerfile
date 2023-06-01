FROM node:18.14.2-bullseye-slim

WORKDIR /bot
COPY ../../package.json ./
COPY ../../package-lock.json ./
COPY ../../tsconfig.json ./
COPY ../../src ./

RUN npm install
RUN npm run build

CMD [ "node", "dist/index.js" ]