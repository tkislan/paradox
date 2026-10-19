import net from 'node:net';
import { vi } from 'vitest';
import { specText } from '../support.ts';
import { html } from './responses.ts';

/**
 * Keeps the next TCP connection from ever opening, as the panel does with one from a source port it saw about a
 * minute earlier: the socket never connects, and the panel never sees its request. Node's servers accept every
 * connection at once, so no fake panel can leave a handshake unanswered; hence the stub. Later connections open as
 * usual. Returns the spy, whose `mock.contexts` are the sockets.
 */
export function ignoreNextConnection() {
  return vi.spyOn(net.Socket.prototype, 'connect').mockImplementationOnce(function (this: net.Socket) {
    // The real connect() sets this too, so writes wait for 'connect' instead of failing with ERR_SOCKET_CLOSED.
    return Object.assign(this, { connecting: true });
  });
}

/**
 * Lets loopback responses that have already been written reach the code under test and run its
 * promise chains. Unlike settle() it does not wait for a duration: every setImmediate hop runs after
 * a full poll phase, which is when the client side of a loopback socket reads what the panel wrote.
 */
export async function drain(hops = 5) {
  for (let hop = 0; hop < hops; hop += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Serves a captured page ({ file } relative to tests/) as the next response for `pathname`. */
export function servePage(panel, pathname, page) {
  panel.respondWith(pathname, html(specText(page)), { times: 1 });
}

/**
 * Makes the panel misbehave for the next request to `pathname`, as a spec "fail" entry describes:
 * { status, body? } | { connection: "refused" | "reset" } | { page: { file } }.
 * Returns an async function that undoes what outlives the request (a refused connection means the
 * panel was stopped; call it before the next tick to bring the panel back on its port).
 */
export async function injectFailure(panel, pathname, fail) {
  if (fail.connection === 'refused') {
    await panel.stop();
    return () => panel.start(panel.port);
  }
  if (fail.connection === 'reset') panel.respondWith(pathname, { destroy: true }, { times: 1 });
  else if (fail.page) servePage(panel, pathname, fail.page);
  else if (fail.status) panel.respondWith(pathname, html(fail.body ?? 'error', fail.status), { times: 1 });
  else throw new Error(`Unknown failure: ${JSON.stringify(fail)}`);
  return async () => {};
}

/**
 * Computes the next response for `pathname` when the request arrives but delivers it only on
 * release(), to model a slow panel. FakePanel's respondWith has no delay, so this wraps the
 * server's own request listener.
 */
export function holdNextResponse(panel, pathname) {
  const [handle] = panel.server.listeners('request');
  let deliver: (() => void) | null = null;
  panel.server.removeListener('request', handle);
  panel.server.on('request', (req, res) => {
    if (!deliver && new URL(req.url, 'http://panel').pathname === pathname) {
      const end = res.end.bind(res);
      res.end = (...args) => {
        deliver = () => end(...args);
        return res;
      };
    }
    handle(req, res);
  });
  return {
    release() {
      if (!deliver) throw new Error(`No ${pathname} request is being held`);
      deliver();
    },
  };
}
