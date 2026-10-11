#!/usr/bin/env bash
# Runs the database migrations as a one-off ECS Fargate task (the API image with the command
# `node apps/api/dist/migrate.js`), waits for it and fails if the migrations fail.
#
# Usage: ecs-run-migrations.sh <prefix> <image>
#   prefix  "<slug>-<env>", e.g. lodgent-dev. The cluster, task definition and network come from
#           the CloudFormation exports the CDK app publishes:
#             <prefix>-ClusterName                ECS cluster name
#             <prefix>-MigrateTaskDefinitionArn   task definition whose container runs the API image
#             <prefix>-AppSubnetIds               comma-separated private subnet IDs
#             <prefix>-AppSecurityGroupId         security group that may reach the database
#   image   API image to migrate with, e.g. 123456789012.dkr.ecr.eu-central-1.amazonaws.com/lodgent-dev-api:<sha>.
#           ECS cannot override a container image per run, so when it differs from the task
#           definition's image a temporary revision with this image is registered (and
#           deregistered afterwards). The container is the one using the same ECR repository.
#
# Environment: MIGRATION_TIMEOUT_SECONDS (default 1800), STARTED_BY (default "migrations"),
#              POLL_SECONDS between task status checks (default 10).
# Exit codes: 0 applied, 1 failed, 3 the exports do not exist yet (stack not deployed).
# Needs the AWS CLI, jq and credentials allowed to read the exports, run the task, pass its roles
# and read its logs (see docs/runbooks/deploy.md).
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <prefix> <image>" >&2
  exit 1
fi
prefix=$1
image=$2
timeout_seconds=${MIGRATION_TIMEOUT_SECONDS:-1800}
started_by=${STARTED_BY:-migrations}
command='["node", "apps/api/dist/migrate.js"]'

error() { echo "::error::$*" >&2; }

exports=$(aws cloudformation list-exports --output json)
export_value() { jq -r --arg name "$1" '[.Exports[] | select(.Name == $name) | .Value][0] // empty' <<<"$exports"; }

cluster=$(export_value "$prefix-ClusterName")
if [[ -z $cluster ]]; then
  echo "::warning::CloudFormation export $prefix-ClusterName not found: the stacks are not deployed yet."
  exit 3
fi
task_definition=$(export_value "$prefix-MigrateTaskDefinitionArn")
subnets=$(export_value "$prefix-AppSubnetIds")
security_group=$(export_value "$prefix-AppSecurityGroupId")
for name in MigrateTaskDefinitionArn AppSubnetIds AppSecurityGroupId; do
  if [[ -z $(export_value "$prefix-$name") ]]; then
    error "CloudFormation export $prefix-$name not found"
    exit 1
  fi
done

definition=$(aws ecs describe-task-definition --task-definition "$task_definition" --query taskDefinition --output json)
# Repository = image reference without digest and tag (a registry port is followed by "/", so it stays).
repository_of='split("@")[0] | sub(":[^:/]*$"; "")'
repository=$(jq -rn --arg image "$image" "\$image | $repository_of")
containers=$(jq -r --arg repo "$repository" \
  "[.containerDefinitions[] | select((.image | $repository_of) == \$repo) | .name] | join(\" \")" <<<"$definition")
read -r -a matches <<<"$containers"
if [[ ${#matches[@]} -ne 1 ]]; then
  error "expected exactly one container using $repository in $task_definition, found ${#matches[@]}"
  exit 1
fi
container=${matches[0]}

temporary=''
cleanup() {
  if [[ -n $temporary ]]; then
    aws ecs deregister-task-definition --task-definition "$temporary" >/dev/null || true
  fi
}
trap cleanup EXIT

run_definition=$task_definition
current_image=$(jq -r --arg c "$container" '.containerDefinitions[] | select(.name == $c) | .image' <<<"$definition")
if [[ $current_image != "$image" ]]; then
  # Same definition with the new image; read-only attributes are dropped (as amazon-ecs-deploy-task-definition does).
  input=$(jq --arg c "$container" --arg image "$image" '
    del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities,
        .registeredAt, .registeredBy, .deregisteredAt)
    | .containerDefinitions |= map(if .name == $c then .image = $image else . end)' <<<"$definition")
  temporary=$(aws ecs register-task-definition --cli-input-json "$input" \
    --query taskDefinition.taskDefinitionArn --output text)
  run_definition=$temporary
  echo "Registered temporary task definition $temporary"
fi

network=$(jq -n --arg subnets "$subnets" --arg sg "$security_group" '{awsvpcConfiguration: {
  subnets: ($subnets | split(",") | map(gsub("\\s"; "")) | map(select(. != ""))),
  securityGroups: [$sg], assignPublicIp: "DISABLED"}}')
overrides=$(jq -n --arg c "$container" --argjson command "$command" \
  '{containerOverrides: [{name: $c, command: $command}]}')

echo "Running migrations on cluster $cluster with $image"
result=$(aws ecs run-task --cluster "$cluster" --task-definition "$run_definition" \
  --launch-type FARGATE --count 1 --network-configuration "$network" --overrides "$overrides" \
  --started-by "$started_by" --output json)
task=$(jq -r '.tasks[0].taskArn // empty' <<<"$result")
if [[ -z $task ]]; then
  error "run-task started no task: $(jq -c '.failures' <<<"$result")"
  exit 1
fi
echo "Started task $task"

deadline=$((SECONDS + timeout_seconds))
while true; do
  described=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --output json)
  status=$(jq -r '.tasks[0].lastStatus' <<<"$described")
  [[ $status == STOPPED ]] && break
  if ((SECONDS > deadline)); then
    error "migrations still running after ${timeout_seconds}s; stopping task $task"
    aws ecs stop-task --cluster "$cluster" --task "$task" --reason "migration timeout" >/dev/null || true
    exit 1
  fi
  echo "  task status: $status"
  sleep "${POLL_SECONDS:-10}"
done

# Print the task's log (awslogs driver): <stream prefix>/<container>/<task id>.
log_group=$(jq -r --arg c "$container" \
  '.containerDefinitions[] | select(.name == $c) | .logConfiguration // {} | select(.logDriver == "awslogs") | .options["awslogs-group"] // empty' <<<"$definition")
stream_prefix=$(jq -r --arg c "$container" \
  '.containerDefinitions[] | select(.name == $c) | .logConfiguration.options["awslogs-stream-prefix"] // empty' <<<"$definition")
if [[ -n $log_group && -n $stream_prefix ]]; then
  echo "--- migration log ($log_group)"
  aws logs get-log-events --log-group-name "$log_group" --log-stream-name "$stream_prefix/$container/${task##*/}" \
    --start-from-head --output json 2>/dev/null | jq -r '.events[].message' || true
  echo "---"
fi

exit_code=$(jq -r --arg c "$container" '.tasks[0].containers[] | select(.name == $c) | .exitCode // empty' <<<"$described")
if [[ $exit_code != 0 ]]; then
  error "migrations failed (exit code: ${exit_code:-none}; stop code: $(jq -r '.tasks[0].stopCode // "-"' <<<"$described"); reason: $(jq -r --arg c "$container" '[.tasks[0].stoppedReason, (.tasks[0].containers[] | select(.name == $c) | .reason)] | map(select(. != null)) | join("; ")' <<<"$described"))"
  exit 1
fi
echo "Migrations applied."
