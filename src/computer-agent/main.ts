// One per Dot inside the shared computer. The provider starts it as that
// Dot's own Linux user (dot-…, home /home/dot-<id>, 0700), so its workspace
// and browser profile are private; the root router forwards to its socket.
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Browser } from './browser.js';
import { Control } from './control.js';
import { createAgentServer } from './server.js';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

const home = process.env.HOME ?? '/home/dot';
const workspace = process.env.PIDOTS_WORKSPACE ?? join(home, 'workspace');
const socket = process.env.PIDOTS_SOCKET ?? '/run/pidots/agent.sock';
// Folders and files from the owner's Mac, mounted at their own paths.
const shared = (process.env.PIDOTS_SHARED ?? '')
  .split('\n')
  .filter((path) => path.startsWith('/'));
mkdirSync(workspace, { recursive: true });
const control = new Control();
const browser = new Browser({
  executablePath: process.env.PIDOTS_CHROMIUM ?? '/usr/bin/chromium',
  profileDir: join(home, '.pidots', 'browser'),
  control,
});
const server = createAgentServer({
  dotId: required('PIDOTS_DOT_ID'),
  token: required('PIDOTS_TOKEN'),
  workspace,
  shared,
  browser,
  control,
});
// The token is in memory now; keep it out of child processes.
delete process.env.PIDOTS_TOKEN;

const port = process.env.PIDOTS_PORT;
if (port) server.listen(Number(port), '127.0.0.1');
else {
  rmSync(socket, { force: true });
  server.listen(socket, () => chmodSync(socket, 0o600));
}
console.log(
  `Pidots computer service ready on ${port ? `port ${port}` : socket}`,
);

const shutdown = () => {
  server.close();
  void browser.close().finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
