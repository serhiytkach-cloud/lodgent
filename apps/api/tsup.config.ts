import { defineConfig } from 'tsup';

// Bundles the API and every internal @lodgent/* package (they ship TypeScript source, so they are
// devDependencies), together with the npm packages those use. Only this app's own `dependencies`
// stay external: they are what the runtime image installs (`pnpm deploy --prod`, see Dockerfile).
// Anything that must be loaded from node_modules at run time belongs there: `pg` is, so that
// OpenTelemetry's pg instrumentation can hook it (a module inlined into the bundle cannot be patched).
// `migrate` is the one-off migration entrypoint the deploy pipeline runs (`node dist/migrate.js`).
export default defineConfig({
  entry: ['src/main.ts', 'src/migrate.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  noExternal: [/^@lodgent\//],
  // Bundled CommonJS packages (the AWS SDK, cheerio, ...) call require() for Node built-ins, and ESM
  // output has no require: without this every output file fails at startup with
  // "Dynamic require of "events" is not supported".
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
