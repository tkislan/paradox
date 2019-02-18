// @flow

const vm = require('vm');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deepArrayEqual(a?: any[], b?: any[]): boolean {
  if (!a || !b || a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function getJsValue(content: string, regexp: RegExp): any {
  const match = regexp.exec(content);
  if (!match) {
    console.error(content);
    console.error(regexp.toString());
    throw new Error('Regex didn\'t match the value');
  }

  const sandbox = Object.create(null);
  return vm.runInNewContext(match[1], sandbox);
}

function* iterateTuples(list: any[]): Iterable<[number, string]> {
  if (list.length % 2 !== 0) throw new Error('Invalid list length, should be divisible by tuple size');

  const tupleCount = list.length / 2;

  for (let i = 0; i < tupleCount; i += 2) {
    const tuple = [0, ''];
    for (let j = 0; j < 2; j += 1) {
      tuple[j] = list[i + j];
    }
    yield tuple;
  }
}

async function retry(maxRetryCount: number, waitTime: number, f: (...any[]) => Promise<void>, ...args: any[]): Promise<any> {
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

function objectEntries<T, U>(object: { [T]: U }): [T, U][] {
  return (Object.entries(object): any)
}

module.exports = {
  sleep,
  deepArrayEqual,
  getJsValue,
  iterateTuples,
  retry,
  objectEntries,
};
