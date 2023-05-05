FROM node:18.14.2-bullseye-slim

COPY . /bot

WORKDIR /bot
RUN npm install
RUN npm run build

CMD [ "node", "dist/index.js" ]