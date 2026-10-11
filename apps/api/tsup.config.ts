import { defineConfig } from 'tsup';

// Bundles the API and every internal @lodgent/* package (they ship TypeScript source);
// third-party dependencies stay external and are installed in the runtime image.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  noExternal: [/^@lodgent\//],
});
