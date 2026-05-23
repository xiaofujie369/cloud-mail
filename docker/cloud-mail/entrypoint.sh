#!/bin/sh
set -eu

if [ -z "${JWT_SECRET:-}" ]; then
  echo "JWT_SECRET is required" >&2
  exit 1
fi

if [ -z "${ADMIN_EMAIL:-}" ]; then
  echo "ADMIN_EMAIL is required" >&2
  exit 1
fi

node <<'NODE'
const fs = require('node:fs');

function asBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function parseDomains() {
  if (process.env.MAIL_DOMAINS) {
    const parsed = JSON.parse(process.env.MAIL_DOMAINS);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('MAIL_DOMAINS must be a non-empty JSON array.');
    }
    return parsed.map(String);
  }
  return [process.env.MAIL_DOMAIN || 'example.com'];
}

const domains = parseDomains();
const toml = `name = "cloud-mail-docker"
main = "src/index.js"
compatibility_date = "2025-06-04"
keep_vars = true

[dev]
ip = "0.0.0.0"
port = 8787
local_protocol = "http"

[[d1_databases]]
binding = "db"
database_name = "cloud-mail"
database_id = "local-cloud-mail"

[[kv_namespaces]]
binding = "kv"
id = "local-cloud-mail-kv"

[assets]
binding = "assets"
directory = "./dist"
not_found_handling = "single-page-application"
run_worker_first = true

[triggers]
crons = ["*/30 * * * *", "0 16 * * *"]

[vars]
ai_model = ""
analysis_cache = ${asBool(process.env.ANALYSIS_CACHE)}
orm_log = ${asBool(process.env.ORM_LOG)}
domain = ${JSON.stringify(domains)}
admin = ${JSON.stringify(process.env.ADMIN_EMAIL)}
jwt_secret = ${JSON.stringify(process.env.JWT_SECRET)}
cors_origin = ${JSON.stringify(process.env.CORS_ORIGIN || '')}
`;

fs.writeFileSync('wrangler-docker.generated.toml', toml);
NODE

exec pnpm exec wrangler dev \
  --config wrangler-docker.generated.toml \
  --local \
  --ip 0.0.0.0 \
  --port 8787 \
  --persist-to /data/wrangler
