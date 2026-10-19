'use strict';

const axios = require('axios').default;

// The panel stops accepting connections for up to about 10 s at a time. A connection attempt it holds up past Linux's
// SYN retry at 7 s gets through only with the next one, at 15 s, and the exchange after that needs a few seconds more.
const TIMEOUT = 20000; // in milliseconds

/**
 * An axios request with a deadline on the whole exchange. axios's own `timeout` stops counting once the headers
 * arrive, so a panel that hangs halfway through a body would stall the caller, and with it every later poll.
 * @param {import('axios').AxiosRequestConfig} config
 * @returns {Promise<import('axios').AxiosResponse>}
 * @throws {Error} `timeout of 20000ms exceeded` with code `ETIMEDOUT` once the deadline passes, otherwise whatever
 *   axios rejects with
 */
async function request(config) {
  const source = axios.CancelToken.source();
  const timer = setTimeout(() => source.cancel(), TIMEOUT);
  try {
    return await axios({ ...config, cancelToken: source.token });
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
