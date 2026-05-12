#!/bin/sh
set -e

echo "Waiting for PostgreSQL to be ready..."
until pg_isready -h "${DB_HOST:-host.docker.internal}" -p "${DB_PORT:-5432}" -U "${DB_USER:-postgres}" -q; do
  echo "PostgreSQL is unavailable - sleeping"
  sleep 2
done
echo "PostgreSQL is ready"

echo "Running database migrations..."
cd /app/src/backend
npx sequelize-cli db:migrate
cd /app

echo "Starting application..."
exec "$@"
