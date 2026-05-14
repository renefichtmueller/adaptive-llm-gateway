#!/bin/bash
set -e
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-llm_gateway}"
DB_USER="${DB_USER:-llm}"
DB_PASS="${DB_PASS:-llm_secure_2026}"
PG_USER="${PG_SUPERUSER:-postgres}"

echo "Creating database and user..."
psql -h $DB_HOST -p $DB_PORT -U $PG_USER -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';" 2>/dev/null || echo "User exists"
psql -h $DB_HOST -p $DB_PORT -U $PG_USER -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" 2>/dev/null || echo "DB exists"
psql -h $DB_HOST -p $DB_PORT -U $PG_USER -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;" 2>/dev/null

echo "Running migrations..."
PGPASSWORD=$DB_PASS psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f packages/gateway/src/db/migrations/001_initial.sql
echo "DB initialized"
