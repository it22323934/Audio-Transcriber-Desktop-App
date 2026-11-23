// esbuild settings for the Electron main process and preload script.
// Both are CommonJS: sandboxed preload scripts can't be ES modules.
import { build, context } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron', 'koffi'], // koffi loads a native .node binary at run time
  sourcemap: true,
  logLevel: 'warning',
};

const entries = [
  { entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' },
  { entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' },
];

export function buildElectron() {
  return Promise.all(entries.map((e) => build({ ...common, ...e })));
}

/** Rebuilds on change and calls onRebuild after each successful build. */
export async function watchElectron(onRebuild) {
  const notify = {
    name: 'notify',
    setup(b) {
      b.onEnd((result) => {
        if (!result.errors.length) onRebuild();
      });
    },
  };
  const contexts = await Promise.all(entries.map((e) => context({ ...common, ...e, plugins: [notify] })));
  await Promise.all(contexts.map((c) => c.watch()));
  return contexts;
}
