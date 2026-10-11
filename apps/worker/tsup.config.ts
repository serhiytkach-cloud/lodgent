import { defineConfig } from 'tsup';

// Like the API: internal @lodgent/* packages (devDependencies) and their npm packages are bundled;
// only this app's `dependencies` stay external and are installed in the runtime image. `pg` is one
// of them so that OpenTelemetry's pg instrumentation can hook it.
export default defineConfig({
  entry: ['src/main.ts'],
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
