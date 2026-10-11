#!/usr/bin/env bash
# Starts the three images against a throwaway Postgres and checks that they work:
#   - all three run as a non-root user;
#   - the migration entrypoint applies every migration (DATABASE_HOST/... parts, as in ECS, then
#     DATABASE_URL), is idempotent, and exits non-zero on failure;
#   - the API boots in production mode, answers /healthz and /readyz, and turns healthy;
#   - the worker starts;
#   - the web app answers /healthz, renders a page with its static assets and turns healthy;
#   - the API and worker stop cleanly on SIGTERM.
# The migration task, API and worker run with a read-only root file system and a /tmp tmpfs, as
# their ECS task definitions do. Every secret below is a fake placeholder: the point is to boot the
# production code path. Run from the repository root (it reads the migrations journal).
#
# Usage: API_IMAGE=... WORKER_IMAGE=... WEB_IMAGE=... .github/scripts/smoke-test-images.sh
# Optional: POSTGRES_IMAGE (default pgvector/pgvector:0.8.7-pg16, as in docker-compose.yml).
set -euo pipefail

: "${API_IMAGE:?set API_IMAGE}" "${WORKER_IMAGE:?set WORKER_IMAGE}" "${WEB_IMAGE:?set WEB_IMAGE}"
postgres_image=${POSTGRES_IMAGE:-pgvector/pgvector:0.8.7-pg16}
journal=packages/db/migrations/meta/_journal.json
id="image-smoke-$$"
network=$id
db_host="$id-pg"

containers=()
cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    for c in "${containers[@]}"; do
      echo "--- logs: $c"
      docker logs "$c" 2>&1 | tail -n 50 || true
    done
  fi
  for c in "${containers[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker network rm "$network" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "::error::$*" >&2
  exit 1
}
step() { echo "==> $*"; }

wait_for() { # <description> <seconds> <command...>
  local what=$1 seconds=$2
  shift 2
  for ((i = 0; i < seconds; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "timed out waiting for $what"
}
healthy() { [[ $(docker inspect -f '{{.State.Health.Status}}' "$1") == healthy ]]; }
host_port() { docker port "$1" "$2/tcp" | head -n 1 | sed 's/.*://'; }
psql_app() { docker exec "$db_host" psql -U app -d app -tAc "$1"; }

# Like ECS: read-only root file system, writable /tmp.
readonly_fs=(--read-only --tmpfs '/tmp:rw,noexec,nosuid,size=64m')
db_parts=(-e "DATABASE_HOST=$db_host" -e DATABASE_PORT=5432 -e DATABASE_NAME=app -e DATABASE_USER=app -e DATABASE_PASSWORD=smoke-db-password)
db_url="postgres://app:smoke-db-password@$db_host:5432/app"
app_env=(
  -e "DATABASE_URL=$db_url"
  -e WEB_BASE_URL=https://app.example.test -e API_BASE_URL=https://api.example.test
  -e AUTH_PROVIDER=cognito -e COGNITO_USER_POOL_ID=eu-central-1_smoke -e COGNITO_CLIENT_ID=smokeclient
  -e AWS_REGION=eu-central-1 -e KMS_PROVIDER=aws -e KMS_KEY_ID=alias/smoke
  -e EMAIL_PROVIDER=ses -e "EMAIL_FROM=Bookings <bookings@example.test>"
  -e INTERNAL_API_TOKEN=smoke-internal-token-placeholder
  -e SIGNING_SECRET=smoke-signing-secret-placeholder-0123456789
  -e AUTH_DEV_SECRET=smoke-auth-dev-secret-placeholder-0123456789
  -e STRIPE_SECRET_KEY=sk_test_smoke_fake -e STRIPE_PUBLISHABLE_KEY=pk_test_smoke_fake
  -e STRIPE_WEBHOOK_SECRET=whsec_smoke_fake
  -e APALEO_CLIENT_ID=smoke-apaleo-client -e APALEO_CLIENT_SECRET=smoke-apaleo-secret
  -e APALEO_WEBHOOK_TOKEN=smoke-apaleo-webhook-token
)

step "image users"
for image in "$API_IMAGE" "$WORKER_IMAGE" "$WEB_IMAGE"; do
  uid=$(docker run --rm --entrypoint id "$image" -u)
  [[ $uid != 0 ]] || fail "$image runs as root"
done

step "starting Postgres ($postgres_image)"
docker network create "$network" >/dev/null
containers+=("$db_host")
docker run -d --name "$db_host" --network "$network" \
  -e POSTGRES_USER=app -e POSTGRES_PASSWORD=smoke-db-password -e POSTGRES_DB=app "$postgres_image" >/dev/null
wait_for "Postgres" 60 docker exec "$db_host" pg_isready -U app -d app -h 127.0.0.1
sleep 2

step "migrations"
docker run --rm --network "$network" "${readonly_fs[@]}" "${db_parts[@]}" "$API_IMAGE" \
  node apps/api/dist/migrate.js || fail "migrations failed"
expected=$(grep -c '"tag"' "$journal")
applied=$(psql_app 'select count(*) from drizzle.__drizzle_migrations')
[[ $applied == "$expected" ]] || fail "applied $applied migrations, the journal has $expected"
docker run --rm --network "$network" "${readonly_fs[@]}" -e "DATABASE_URL=$db_url" "$API_IMAGE" \
  node apps/api/dist/migrate.js || fail "re-running migrations (DATABASE_URL) failed"
[[ $(psql_app 'select count(*) from drizzle.__drizzle_migrations') == "$expected" ]] ||
  fail "re-running migrations changed the migrations table"
if docker run --rm --network "$network" "${db_parts[@]}" -e DATABASE_PASSWORD=wrong "$API_IMAGE" \
  node apps/api/dist/migrate.js >/dev/null 2>&1; then
  fail "migrations with a wrong password exited 0"
fi

step "api"
api="$id-api"
containers+=("$api")
docker run -d --name "$api" --network "$network" "${readonly_fs[@]}" -p 127.0.0.1::4000 \
  --health-interval=2s "${app_env[@]}" "$API_IMAGE" >/dev/null
api_port=$(host_port "$api" 4000)
wait_for "API /healthz" 60 curl -fsS "http://127.0.0.1:$api_port/healthz"
curl -fsS "http://127.0.0.1:$api_port/healthz" | grep -q '"ok":true' || fail "API /healthz body"
curl -fsS "http://127.0.0.1:$api_port/readyz" | grep -q '"ok":true' || fail "API /readyz"
wait_for "API container health" 60 healthy "$api"

step "worker"
worker="$id-worker"
containers+=("$worker")
docker run -d --name "$worker" --network "$network" "${readonly_fs[@]}" "${app_env[@]}" \
  "$WORKER_IMAGE" >/dev/null
wait_for "worker start" 60 sh -c "docker logs '$worker' 2>&1 | grep -q '\"msg\":\"worker started\"'"

step "web"
web="$id-web"
containers+=("$web")
docker run -d --name "$web" --network "$network" -p 127.0.0.1::3000 --health-interval=2s \
  -e "API_INTERNAL_URL=http://$api:4000" -e API_BASE_URL=https://api.example.test \
  -e WEB_BASE_URL=https://app.example.test -e AUTH_PROVIDER=cognito \
  -e COGNITO_DOMAIN=auth.example.test -e COGNITO_CLIENT_ID=smokeclient "$WEB_IMAGE" >/dev/null
web_port=$(host_port "$web" 3000)
wait_for "web /healthz" 60 curl -fsS "http://127.0.0.1:$web_port/healthz"
curl -fsS "http://127.0.0.1:$web_port/healthz" | grep -q '"ok":true' || fail "web /healthz body"
page=$(curl -fsS "http://127.0.0.1:$web_port/login") || fail "web /login"
asset=$(grep -oE '/_next/static/[^"]+\.(css|js)' <<<"$page" | head -n 1)
[[ -n $asset ]] || fail "web /login references no static assets"
curl -fsS -o /dev/null "http://127.0.0.1:$web_port$asset" || fail "web static asset $asset"
wait_for "web container health" 60 healthy "$web"

step "graceful shutdown"
for c in "$api" "$worker"; do
  docker stop -t 20 "$c" >/dev/null
  code=$(docker inspect -f '{{.State.ExitCode}}' "$c")
  [[ $code == 0 ]] || fail "$c exited with $code after SIGTERM"
done

echo "Image smoke test passed."
