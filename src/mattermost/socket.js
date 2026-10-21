// -----------------------------------------------------------------------------
// The WebSocket of Mattermost (/api/v4/websocket): the server pushes the events
// the bot can see (`posted` for a new message). Authentication by the
// `authentication_challenge` action, the documented way for a client that
// cannot set headers. A ping every 30 s: a connection that stops answering
// (a NAT that forgot it, a server gone) is closed and the caller reconnects.
//
// Node 22+ has a global WebSocket (undici): no dependency. Injected by the tests.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, MattermostError } from './client.js';

export const PING_INTERVAL_MS = 30_000;
export const OPEN_TIMEOUT_MS = 15_000;

/**
 * Opens the WebSocket and waits for the `hello` event of the server.
 * @param {object} options
 * @param {string} options.url ws:// or wss:// address
 * @param {string} options.token
 * @param {typeof WebSocket} [options.WebSocket]
 * @param {AbortSignal} [options.signal] closes the socket
 * @param {(event: object) => void} options.onEvent every server event but `hello`
 * @param {() => void} [options.onAlive] the server answered (hello, a pong, an event)
 * @param {number} [options.pingIntervalMs]
 * @returns {Promise<{ closed: Promise<string>, close(): void }>} `closed` resolves
 *   with the reason once the connection is gone, whoever closed it
 */
export function openSocket({
  url,
  token,
  WebSocket: Impl = globalThis.WebSocket,
  signal,
  onEvent,
  onAlive = () => {},
  pingIntervalMs = PING_INTERVAL_MS,
  openTimeoutMs = OPEN_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new Impl(url);
    } catch (err) {
      reject(new MattermostError(ERROR_KINDS.INVALID_URL, `Bad WebSocket address: ${err.message}`));
      return;
    }
    let seq = 0;
    let opened = false;
    let pending = null; // seq of the ping waiting for its answer
    let timer = null;
    let openTimer = null;
    let finish;
    const closed = new Promise((done) => {
      finish = done;
    });

    const send = (action, data) => {
      seq += 1;
      socket.send(JSON.stringify({ seq, action, ...(data ? { data } : {}) }));
      return seq;
    };

    let ended = false;
    function end(reason) {
      if (ended) {
        return;
      }
      ended = true;
      clearTimeout(openTimer);
      clearInterval(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!opened) {
        reject(
          reason instanceof MattermostError
            ? reason
            : new MattermostError(ERROR_KINDS.UNREACHABLE, `WebSocket closed: ${reason}`),
        );
      }
      finish(String(reason?.message ?? reason));
    }

    const close = (reason) => {
      end(reason); // first: the reason of the integration wins over the close event
      try {
        socket.close();
      } catch {
        // already closing
      }
    };

    const onAbort = () => close('stopped');
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) {
      onAbort();
      return;
    }

    openTimer = setTimeout(
      () =>
        close(
          new MattermostError(ERROR_KINDS.TIMEOUT, `No WebSocket hello within ${openTimeoutMs} ms`),
        ),
      openTimeoutMs,
    );

    let challenged = false;
    let answered = false; // the server answered the challenge (seq_reply or hello)
    socket.addEventListener('open', () => {
      challenged = true;
      send('authentication_challenge', { token });
    });

    socket.addEventListener('message', (message) => {
      let data;
      try {
        data = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data));
      } catch {
        return;
      }
      answered = true;
      if (data?.seq_reply !== undefined) {
        if (data.status === 'FAIL' && data.seq_reply === 1 && !opened) {
          close(new MattermostError(ERROR_KINDS.TOKEN, 'WebSocket authentication refused'));
        } else if (data.seq_reply === pending) {
          pending = null;
          onAlive();
        }
        return;
      }
      if (data?.event === 'hello') {
        if (!opened) {
          opened = true;
          clearTimeout(openTimer);
          timer = setInterval(() => {
            if (pending !== null) {
              close('no answer to the last ping');
              return;
            }
            pending = send('ping');
          }, pingIntervalMs);
          timer.unref?.();
          onAlive();
          resolve({ closed, close: () => close('closed by the integration') });
        }
        return;
      }
      if (typeof data?.event === 'string') {
        onAlive();
        try {
          onEvent(data);
        } catch {
          // the handler logs its own failures: one event never closes the socket
        }
      }
    });

    socket.addEventListener('error', () => {
      // An `error` is always followed by a `close`: the reason is given there.
    });

    socket.addEventListener('close', (event) => {
      if (challenged && !answered) {
        // A real Mattermost closes the socket, without a reply, on a refused token.
        end(new MattermostError(ERROR_KINDS.TOKEN, 'WebSocket authentication refused'));
        return;
      }
      end(`code ${event?.code ?? 'unknown'}`);
    });
  });
}
