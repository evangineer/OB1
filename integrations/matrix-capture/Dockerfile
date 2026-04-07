ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE}

WORKDIR /app

COPY package.json ./
RUN npm install

COPY service.ts ./

RUN mkdir -p /data/indexeddb

CMD ["npm", "run", "start"]
