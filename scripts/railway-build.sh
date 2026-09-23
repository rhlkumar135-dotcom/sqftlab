#!/bin/bash
# Railway build script — swaps schema to postgresql and regenerates
set -ex

echo "=== sqftLab Railway Build ==="
echo "PWD: $(pwd)"

# Only a genuine postgres:// URL justifies switching the provider. Testing merely
# for a non-empty value let a SQLite path (or a literal "${{...}}" placeholder)
# through, swapping the schema to postgresql while prisma.config.ts still resolved
# a SQLite URL — every later step then died with P1013, the server could not reach
# its database, and the deploy failed its healthcheck.
case "${DATABASE_URL:-}" in
  postgresql://*|postgres://*)
    echo "PostgreSQL URL detected — switching schema provider..."
    sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma
    ;;
  "")
    echo "WARN: DATABASE_URL is unset — keeping the SQLite schema."
    ;;
  *)
    echo "WARN: DATABASE_URL is set but is not a postgresql:// URL — keeping the SQLite schema."
    echo "      In Railway, reference the Postgres service's DATABASE_URL via 'Add Reference'."
    ;;
esac
echo "Schema provider now: $(awk '/^datasource/{d=1} d&&/provider/{print;exit}' prisma/schema.prisma)"

# Install deps (skip postinstall to avoid generating with wrong provider)
echo "Installing dependencies..."
bun install --frozen-lockfile 2>/dev/null || bun install

# Clean and regenerate Prisma client with correct provider
echo "Regenerating Prisma client..."
rm -rf src/generated/prisma
bun x prisma generate

# Run Shogo generate
echo "Running Shogo generate..."
set +e
bun run generate
GENERATE_STATUS=$?
set -e

# src/generated/ is gitignored, so it only exists if this step wrote it. server.tsx
# imports it inside a silent try/catch, which means a failure here produces a
# container that boots and passes its healthcheck while the entire CRUD API is
# missing — the symptom is blank data pages, not a crash. Say so loudly instead.
if [ ! -f src/generated/index.ts ]; then
  echo "############################################################"
  echo "WARNING: src/generated/index.ts is MISSING (generate exit $GENERATE_STATUS)."
  echo "The server will boot and /health will pass, but every generated"
  echo "CRUD route will be absent — data pages will fall back to defaults."
  echo "Most common cause: 'prisma db push' could not reach DATABASE_URL."
  echo "Check that DATABASE_URL is a reference to the Postgres service."
  echo "############################################################"
elif [ "$GENERATE_STATUS" -ne 0 ]; then
  echo "NOTE: generate exited $GENERATE_STATUS but routes were produced — continuing."
else
  echo "Generated routes present."
fi

# Build the frontend
echo "Building frontend..."
bun run build

echo "=== Build complete ==="
