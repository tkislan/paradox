'use strict';

const axios = require('axios').default;

const TIMEOUT = 10000; // in milliseconds

/**
 * An axios request with a deadline on the whole exchange. axios's own `timeout` stops counting once the headers
 * arrive, so a panel that hangs halfway through a body would stall the caller, and with it every later poll.
 * Generous rather than tight: a failed poll costs a new login (app.js).
 * @param {import('axios').AxiosRequestConfig} config
 * @returns {Promise<import('axios').AxiosResponse>}
 * @throws {Error} `timeout of 10000ms exceeded` once the deadline passes, otherwise whatever axios rejects with
 */
async function request(config) {
  const source = axios.CancelToken.source();
  const timer = setTimeout(() => source.cancel(), TIMEOUT);
  try {
    return await axios({ ...config, cancelToken: source.token });
  } catch (error) {
    if (axios.isCancel(error)) throw new Error(`timeout of ${TIMEOUT}ms exceeded`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = request;
