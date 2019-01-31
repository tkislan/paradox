const EventEmitter = require('events');

const { getStatus } = require('./api/status');
const { deepArrayEqual } = require('./util');

function statusListener() {
  class StatusEventEmitter extends EventEmitter {}

  const statusEventEmitter = new StatusEventEmitter();

  let prevStatus = { armed: null, raw: { statuszone: [], useraccess: [], alarms: [] } };
  const intervalId = setInterval(async () => {
    let status;
    try {
      status = await getStatus();
    } catch (error) {
      console.error(error);
      return;
    }

    for (const key of ['statuszone', 'useraccess', 'alarms']) {
      const prevRawStatus = prevStatus.raw[key];
      const rawStatus = status.raw[key];
      if (!deepArrayEqual(prevRawStatus, rawStatus)) {
        console.log(`${key} changed`);
        console.log(prevRawStatus.join(','));
        console.log(rawStatus.join(','));
      }
    }

    if (prevStatus.armed !== status.armed) statusEventEmitter.emit('armedChanged', status.armed);

    prevStatus = status;
  }, 1000);

  return {
    on: (...args) => statusEventEmitter.on(...args),
    stop: () => clearInterval(intervalId),
  };
}

module.exports = {
  statusListener,
};
