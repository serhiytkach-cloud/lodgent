import { App } from 'aws-cdk-lib';
import { defineStacks } from '../lib/lodgent';

// Offline and environment-agnostic (account from the deploying credentials, region from context):
// `cdk synth` needs no AWS credentials. See docs/runbooks/aws-infrastructure.md for context keys.
const app = new App();
defineStacks(app);
app.synth();
