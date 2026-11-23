import { buildElectron } from './esbuild.config.mjs';

await buildElectron();
console.log('Built dist-electron/');
