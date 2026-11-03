// Bundles the React UI (web/src) into public/app.js + public/app.css.
//   node web/build.mjs          production build (minified)
//   node web/build.mjs --watch  rebuild on every change
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const watch = process.argv.includes('--watch');
const options = {
  absWorkingDir: root,
  entryPoints: ['web/src/main.jsx'],
  bundle: true,
  outfile: 'public/app.js',
  jsx: 'automatic',
  loader: { '.js': 'jsx' },
  minify: !watch,
  sourcemap: watch,
  target: ['chrome110', 'edge110', 'firefox110', 'safari16'],
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  nodePaths: [fileURLToPath(new URL('./node_modules', import.meta.url))],
  logLevel: 'info',
};
if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching web/src for changes...');
} else {
  await build(options);
}
