'use strict';

const http = require('http');

const axios = require('axios').default;

const TIMEOUT = 20000; // in milliseconds

// The panel ignores a new connection from a source port it saw about a minute earlier, along with every SYN retry of
// it, while connections from other ports go through. On the LAN it answers a SYN in well under a millisecond, so a
// connection not open after this long is one of those, and giving it up lets the next request try from another port.
const CONNECT_TIMEOUT = 2000; // in milliseconds

class ConnectTimeoutAgent extends http.Agent {
  /** @type {http.Agent['createConnection']} */
  createConnection(options, callback) {
    const socket = /** @type {import('net').Socket} */ (super.createConnection(options, callback));
    const timer = setTimeout(() => {
      socket.destroy(Object.assign(new Error(`connect timeout of ${CONNECT_TIMEOUT}ms exceeded`), { code: 'ETIMEDOUT' }));
    }, CONNECT_TIMEOUT);
    socket.once('connect', () => clearTimeout(timer));
    socket.once('close', () => clearTimeout(timer));
    return socket;
  }
}

// The options of Node 24's global agent.
const agent = new ConnectTimeoutAgent({ keepAlive: true, timeout: 5000 });

/**
 * An axios request with a deadline on the whole exchange. axios's own `timeout` stops counting once the headers
 * arrive, so a panel that hangs halfway through a body would stall the caller, and with it every later poll.
 * @param {import('axios').AxiosRequestConfig} config
 * @returns {Promise<import('axios').AxiosResponse>}
 * @throws {Error} `connect timeout of 2000ms exceeded` with code `ETIMEDOUT` when the connection has not opened by
 *   then, `timeout of 20000ms exceeded` with code `ETIMEDOUT` once the deadline passes, otherwise whatever axios
 *   rejects with
 */
async function request(config) {
  const source = axios.CancelToken.source();
  const timer = setTimeout(() => source.cancel(), TIMEOUT);
  try {
    return await axios({ ...config, httpAgent: agent, cancelToken: source.token });
  } catch (error) {
    if (axios.isCancel(error)) {
      throw Object.assign(new Error(`timeout of ${TIMEOUT}ms exceeded`), { code: 'ETIMEDOUT' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a request rejected without a whole HTTP response to show for it: the deadline passed, the connection was
 * refused or reset, the body was cut short, the bytes were not valid HTTP or did not decompress, or the redirects ran
 * past the limit. An HTTP error status is an answer, and so is a page that fails to parse.
 * @param {any} error what `request` rejected with
 * @returns {boolean}
 */
function isUnanswered(error) {
  return error.code === 'ETIMEDOUT' || (error.request !== undefined && error.response === undefined);
}

request.isUnanswered = isUnanswered;

module.exports = request;
