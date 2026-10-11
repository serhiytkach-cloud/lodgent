import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://lodgent:lodgent@localhost:5432/lodgent',
  },
  strict: true,
  verbose: true,
});
