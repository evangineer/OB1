ARG WOLFI_NODE_IMAGE=ghcr.io/gitguardian/wolfi/node

FROM ${WOLFI_NODE_IMAGE}

WORKDIR /app

COPY package.json ./
RUN npm install

COPY service.ts ./

RUN mkdir -p /data/indexeddb

CMD ["npm", "run", "start"]
