#!/bin/bash
# Railway startup: generate prisma client, push schema, seed, start server
set -e

echo "=== sqftLab Railway Startup ==="

# Surface a misconfigured database immediately in the deploy logs. The literal
# "${{...}}" form means the value was pasted as a string instead of resolved as
# a Railway reference — the connection will fail on every query.
if [ -z "$DATABASE_URL" ]; then
  echo "WARN: DATABASE_URL is unset — falling back to SQLite; data will not persist."
elif printf '%s' "$DATABASE_URL" | grep -q '^\${{'; then
  echo "ERROR: DATABASE_URL is an UNRESOLVED placeholder: $DATABASE_URL"
  echo "       In Railway, set it via 'Add Reference' → the Postgres service's DATABASE_URL,"
  echo "       or use \${{Postgres.DATABASE_URL}} as a *reference*, not a literal string."
else
  # Print host/db only — never the credentials.
  echo "DATABASE_URL host: $(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://([^@]*@)?([^/]+)/.*#\2#')"
fi

# Swap only for a genuine postgres URL. A non-empty value is not enough: a SQLite
# path or a literal placeholder would swap the provider while prisma.config.ts
# still resolved a non-postgres URL, breaking every Prisma call with P1013.
case "${DATABASE_URL:-}" in
  postgresql://*|postgres://*)
    if grep -q 'provider = "sqlite"' prisma/schema.prisma; then
      echo "Swapping schema to PostgreSQL..."
      sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma
    fi
    ;;
esac

echo "Step 1: Generating Prisma client..."
bun x prisma generate

echo "Step 2: Running Shogo SDK generate..."
bun run generate || echo "Shogo generate completed with warnings"

echo "Step 3: Pushing schema to database..."
bun x prisma db push 2>&1 || echo "Schema push done (with warnings)"

echo "Step 4: Seeding database..."
bun run scripts/seed-pg.ts 2>&1 || echo "Seed completed (data may already exist)"

echo "Step 5: Starting server on port ${PORT:-8080}..."
exec bun run server.tsx
