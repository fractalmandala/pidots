// Runs as root inside the one shared computer. The host relays every Dot's
// port to this socket; each request goes to the service of the Dot named in
// `x-pidots-dot-id`, which still checks that Dot's own token. A Dot's
// service socket lives in its private home, so only this router reaches it.
import { chmodSync, rmSync } from 'node:fs';
import {
  createServer,
  request as forward,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

const DOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The service socket for a Dot, or undefined when the id is unsafe. */
export function dotSocket(id: unknown): string | undefined {
  if (typeof id !== 'string' || !DOT_ID.test(id)) return undefined;
  return `/home/dot-${id}/.pidots/agent.sock`;
}

export function routeRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  socketFor: (id: unknown) => string | undefined = dotSocket,
) {
  const socketPath = socketFor(incoming.headers['x-pidots-dot-id']);
  if (!socketPath) {
    outgoing.writeHead(404, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ error: 'Unknown Dot.' }));
    return;
  }
  const upstream = forward(
    {
      socketPath,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on('error', () => {
    if (!outgoing.headersSent) {
      outgoing.writeHead(503, { 'Content-Type': 'application/json' });
      outgoing.end(
        JSON.stringify({ error: 'This Dot’s computer is not running.' }),
      );
    } else outgoing.destroy();
  });
  incoming.pipe(upstream);
}

export function createRouter(socketFor = dotSocket) {
  return createServer((incoming, outgoing) =>
    routeRequest(incoming, outgoing, socketFor),
  );
}

if (process.env.PIDOTS_ROUTER_SOCKET) {
  const socket = process.env.PIDOTS_ROUTER_SOCKET;
  rmSync(socket, { force: true });
  const server = createRouter();
  server.listen(socket, () => chmodSync(socket, 0o600));
  console.log(`Pidots computer router ready on ${socket}`);
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
