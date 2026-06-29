import { build, context } from 'esbuild';

const sharedConfig = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  target: 'node20',
  external: ['vscode', 'ssh2'],
  logLevel: 'info',
  tsconfig: 'tsconfig.json',
};

async function run() {
  if (process.argv.includes('--watch')) {
    const buildContext = await context(sharedConfig);
    await buildContext.watch();
    return;
  }

  await build(sharedConfig);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
