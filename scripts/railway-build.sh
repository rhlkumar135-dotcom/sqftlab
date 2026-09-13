#!/bin/bash
# Railway build script — swaps schema to postgresql and regenerates
set -ex

echo "=== sqftLab Railway Build ==="
echo "PWD: $(pwd)"
echo "DATABASE_URL set: $([ -n "$DATABASE_URL" ] && echo YES || echo NO)"

# If DATABASE_URL is set, switch schema to PostgreSQL
if [ -n "$DATABASE_URL" ]; then
  echo "PostgreSQL detected — switching schema provider..."
  sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma
  echo "Schema after swap:"
  head -12 prisma/schema.prisma
fi

# Install deps (skip postinstall to avoid generating with wrong provider)
echo "Installing dependencies..."
bun install --frozen-lockfile 2>/dev/null || bun install

# Clean and regenerate Prisma client with correct provider
echo "Regenerating Prisma client..."
rm -rf src/generated/prisma
bun x prisma generate

# Run Shogo generate
echo "Running Shogo generate..."
bun run generate || echo "Shogo generate failed (non-fatal)"

# Build the frontend
echo "Building frontend..."
bun run build

echo "=== Build complete ==="
