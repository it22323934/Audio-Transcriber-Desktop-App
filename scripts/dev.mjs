// npm run dev: Vite dev server for the pages (hot reload) + esbuild watch for
// the main process, restarting Electron when main or preload change.
import { spawn } from 'node:child_process';
import electron from 'electron';
import { createServer } from 'vite';
import { watchElectron } from './esbuild.config.mjs';

const server = await createServer();
await server.listen();
const url = `http://localhost:${server.config.server.port}`;

// VS Code's terminal sets this, which would make Electron behave like plain Node.
const env = { ...process.env, VITE_DEV_SERVER_URL: url };
delete env.ELECTRON_RUN_AS_NODE;

let child = null;
let restarting = false;
let timer = null;

function launch() {
  child = spawn(electron, ['.'], { stdio: 'inherit', env });
  child.on('exit', (code) => {
    if (restarting) return;
    void server.close();
    process.exit(code ?? 0);
  });
}

await watchElectron(() => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!child) return launch();
    restarting = true;
    child.once('exit', () => {
      restarting = false;
      launch();
    });
    child.kill();
  }, 200);
});
