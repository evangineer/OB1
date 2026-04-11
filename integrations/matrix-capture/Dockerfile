ARG NODE_IMAGE=node:20-bookworm-slim

FROM ${NODE_IMAGE}

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    g++ \
    libcairo2-dev \
    libgif-dev \
    libjpeg-dev \
    libpango1.0-dev \
    librsvg2-dev \
    make \
    pkg-config \
    python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install

COPY service.ts ./
COPY decrypt-bridge.ts ./
COPY idb-persistence.ts ./
COPY database.types.ts ./

RUN mkdir -p /data/indexeddb

CMD ["npm", "run", "start"]
