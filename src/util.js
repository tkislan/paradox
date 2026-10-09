'use strict';

const vm = require('vm');

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {any[]} [a]
 * @param {any[]} [b]
 * @returns {boolean}
 */
function deepArrayEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * @param {string} content
 * @param {RegExp} regexp
 * @returns {any}
 */
function getJsValue(content, regexp) {
  const match = regexp.exec(content);
  if (!match) {
    console.error(content);
    console.error(regexp.toString());
    throw new Error('Regex didn\'t match the value');
  }

  const sandbox = Object.create(null);
  return vm.runInNewContext(match[1], sandbox);
}

/**
 * @param {any[]} list
 * @returns {Iterable<[number, string]>}
 */
function* iterateTuples(list) {
  if (list.length % 2 !== 0) throw new Error('Invalid list length, should be divisible by tuple size');

  const tupleCount = list.length / 2;

  for (let i = 0; i < tupleCount; i += 2) {
    /** @type {[number, string]} */
    const tuple = [0, ''];
    for (let j = 0; j < 2; j += 1) {
      tuple[j] = list[i + j];
    }
    yield tuple;
  }
}

/**
 * @param {number} maxRetryCount
 * @param {number} waitTime
 * @param {(...args: any[]) => Promise<void>} f
 * @param {...any} args
 * @returns {Promise<any>}
 */
async function retry(maxRetryCount, waitTime, f, ...args) {
  let retryCount = 0;

  while (true) {
    try {
      return await f(...args);
    } catch (error) {
      if (retryCount >= maxRetryCount) throw error;
      retryCount += 1;
    }
  }
}

/**
 * @template {string} T
 * @template U
 * @param {{ [key in T]: U }} object
 * @returns {[T, U][]}
 */
function objectEntries(object) {
  return /** @type {any} */ (Object.entries(object))
}

module.exports = {
  sleep,
  deepArrayEqual,
  getJsValue,
  iterateTuples,
  retry,
  objectEntries,
};
