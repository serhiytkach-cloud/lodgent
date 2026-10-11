#!/bin/bash
# Creates the AWS resources the apps expect when running against LocalStack.
set -euo pipefail

awslocal sqs create-queue --queue-name lodgent-jobs-dlq >/dev/null
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/lodgent-jobs-dlq \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
awslocal sqs create-queue --queue-name lodgent-jobs \
  --attributes "{\"VisibilityTimeout\":\"120\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" >/dev/null

awslocal kms create-alias --alias-name alias/lodgent-tokens \
  --target-key-id "$(awslocal kms create-key --query 'KeyMetadata.KeyId' --output text)"

awslocal ses verify-email-identity --email-address bookings@lodgent.local

echo "LocalStack resources ready"
