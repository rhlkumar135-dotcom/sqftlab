# Deterministic image for Railway.
#
# railway.toml previously used builder = "NIXPACKS", which left the toolchain to
# auto-detection. Both package.json and bun.lock are present in this repo, so
# detection can settle on Node and never install Bun — scripts/railway-build.sh
# then fails on its first `bun` call. An explicit image removes that whole class
# of failure: the Bun runtime is guaranteed, and the build/start commands are the
# same two scripts used everywhere else.
FROM oven/bun:1.2-debian

WORKDIR /app

# railway-build.sh and railway-setup.sh both use awk and sed to inspect/rewrite
# the Prisma datasource provider. sed ships in the Debian base; gawk does not.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gawk ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Railway exports the deployed commit to the build. Declared as an ARG because
# a Docker build only sees build-stage variables that are explicitly declared —
# without this, vite.config.ts cannot read it and stamps "unknown" instead.
# The stamp is what makes "is the live site stale?" answerable from View Source
# rather than guesswork, so it needs to carry a real revision.
ARG RAILWAY_GIT_COMMIT_SHA
ENV RAILWAY_GIT_COMMIT_SHA=${RAILWAY_GIT_COMMIT_SHA}

# Source first, then a single build step: prisma generate + shogo generate +
# vite build. See scripts/railway-build.sh for what each phase does.
COPY . .

RUN bash scripts/railway-build.sh

ENV NODE_ENV=production
EXPOSE 3001

# prisma db push, seed, then the Hono server on $PORT.
CMD ["bash", "scripts/railway-setup.sh"]
