import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runMigrations } from '../migrate';

const rootEnv = resolve(import.meta.dirname, '../../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const url = process.env.DATABASE_URL ?? 'postgres://lodgent:lodgent@localhost:5432/lodgent';
await runMigrations(url);
console.info(`Migrations applied to ${new URL(url).host}${new URL(url).pathname}`);
