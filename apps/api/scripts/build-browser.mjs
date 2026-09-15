import { build } from 'esbuild';
await build({ entryPoints: ['src/identity/browser.ts'], outfile: 'dist/identity/browser.js', bundle: true, platform: 'browser', target: 'es2022', minify: true });
