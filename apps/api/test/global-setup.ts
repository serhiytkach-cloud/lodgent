import { startTestDatabase } from '@lodgent/db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const db = await startTestDatabase();
  project.provide('databaseUrl', db.url);
  return async () => {
    await db.stop();
  };
}
