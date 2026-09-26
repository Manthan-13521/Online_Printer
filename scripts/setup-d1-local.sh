#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
state_dir="$repository_root/.wrangler/local"

cd "$repository_root"

pnpm --dir apps/api/worker exec wrangler d1 execute printgo-local \
  --config="$repository_root/database/wrangler.local.jsonc" \
  --local \
  --persist-to="$state_dir" \
  --file="$repository_root/database/migrations/0001_initial_schema.sql"

pnpm --dir apps/api/worker exec wrangler d1 execute printgo-local \
  --config="$repository_root/database/wrangler.local.jsonc" \
  --local \
  --persist-to="$state_dir" \
  --file="$repository_root/database/migrations/0002_customer_draft_upload.sql"

pnpm --dir apps/api/worker exec wrangler d1 execute printgo-local \
  --config="$repository_root/database/wrangler.local.jsonc" \
  --local \
  --persist-to="$state_dir" \
  --file="$repository_root/database/migrations/0003_payment_idempotency.sql"

pnpm --dir apps/api/worker exec wrangler d1 execute printgo-local \
  --config="$repository_root/database/wrangler.local.jsonc" \
  --local \
  --persist-to="$state_dir" \
  --file="$repository_root/database/migrations/0004_customer_tracking.sql"

pnpm --dir apps/api/worker exec wrangler d1 execute printgo-local \
  --config="$repository_root/database/wrangler.local.jsonc" \
  --local \
  --persist-to="$state_dir" \
  --file="$repository_root/database/seeds/0001_development.sql"

echo "Local PrintGo D1 is ready. Run: pnpm admin:bootstrap"
