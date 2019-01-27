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
      if (!deepArrayEqual(prevStatus.raw[key], status.raw[key])) {
        console.log(`${key} changed`);
        console.log(prevStatus[key].join(','));
        console.log(status[key].join(','));
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
