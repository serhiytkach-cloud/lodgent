import { BRAND } from '@lodgent/shared';
import { App, Tags } from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';

const app = new App();

for (const envName of ['dev', 'prod'] as const) {
  const prefix = `${BRAND.slug}-${envName}`;
  new NetworkStack(app, `${prefix}-network`, {
    envName,
    natGateways: envName === 'prod' ? 2 : 1,
  });
  Tags.of(app).add('app', BRAND.slug);
}

app.synth();
