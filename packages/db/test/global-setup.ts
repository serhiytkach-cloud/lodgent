import type { TestProject } from 'vitest/node';
import { startTestDatabase } from '../src/testing';

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
