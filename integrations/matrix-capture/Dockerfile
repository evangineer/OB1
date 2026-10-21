ARG NODE_IMAGE=node:20-bookworm-slim

FROM ${NODE_IMAGE}

WORKDIR /app

# G4: entrypoint.sh takes the writer lock with flock (util-linux); fail the build if it is missing.
RUN command -v flock

# Same dependency set as CI: the lockfile, installed with npm ci (tsx is a runtime dependency).
COPY package.json package-lock.json ./
RUN npm ci

COPY *.ts entrypoint.sh ./

RUN mkdir -p /data/indexeddb

# G7: node is started directly (not through npm or the tsx CLI, which fork) so SIGTERM reaches it;
# the entrypoint takes the lock on fd 9 and execs this command.
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "--import", "tsx", "service.ts"]
