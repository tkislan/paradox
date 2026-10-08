import { loadBridge } from '../support.js';

export const loadUtil = () => loadBridge().load('util.js');

/** A stand-in for an async function whose successive calls throw or return as `attempts` says, counting calls in `.calls`. */
export function scripted(attempts) {
  const f = async () => {
    const attempt = attempts[f.calls];
    f.calls += 1;
    if (!attempt) throw new Error('script exhausted');
    if ('throws' in attempt) throw new Error(attempt.throws);
    return attempt.returns;
  };
  f.calls = 0;
  return f;
}
