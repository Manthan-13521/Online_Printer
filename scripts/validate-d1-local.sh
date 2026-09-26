#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
validation_dir=$(mktemp -d "${TMPDIR:-/tmp}/printgo-d1.XXXXXX")

cleanup() {
  rm -rf -- "$validation_dir"
}
trap cleanup EXIT INT TERM

cd "$repository_root"

pnpm --dir apps/api/worker exec wrangler d1 execute printgo-local \
  --config="$repository_root/database/wrangler.local.jsonc" \
  --local \
  --persist-to="$validation_dir" \
  --file="$repository_root/database/migrations/0001_initial_schema.sql"

pnpm --dir apps/api/worker exec wrangler d1 execute printgo-local \
  --config="$repository_root/database/wrangler.local.jsonc" \
  --local \
  --persist-to="$validation_dir" \
  --file="$repository_root/database/migrations/0002_customer_draft_upload.sql"

pnpm --dir apps/api/worker exec wrangler d1 execute printgo-local \
  --config="$repository_root/database/wrangler.local.jsonc" \
  --local \
  --persist-to="$validation_dir" \
  --file="$repository_root/database/migrations/0003_payment_idempotency.sql"

pnpm --dir apps/api/worker exec wrangler d1 execute printgo-local \
  --config="$repository_root/database/wrangler.local.jsonc" \
  --local \
  --persist-to="$validation_dir" \
  --file="$repository_root/database/migrations/0004_customer_tracking.sql"

pnpm --dir apps/api/worker exec wrangler d1 execute printgo-local \
  --config="$repository_root/database/wrangler.local.jsonc" \
  --local \
  --persist-to="$validation_dir" \
  --file="$repository_root/database/seeds/0001_development.sql"

pnpm --dir apps/api/worker exec wrangler d1 execute printgo-local \
  --config="$repository_root/database/wrangler.local.jsonc" \
  --local \
  --persist-to="$validation_dir" \
  --command="SELECT id, shop_name FROM installation; SELECT COUNT(*) AS table_count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%';"
