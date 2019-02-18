// @flow

const EventEmitter = require('events');

const { getStatus } = require('./api/status');
const { deepArrayEqual } = require('./util');

const DISARMED_STATUS = 1;
const ARMED_STATUS = 2;
const ARMING_STATUS = 7;


function isArmed(useraccess?: number[]) {
  if (!useraccess) return null;
  switch (parseInt(useraccess, 10)) {
    case ARMED_STATUS:
    case ARMING_STATUS:
      return true;
    case DISARMED_STATUS:
      return false;
    default:
      return null;
  }
}

function initSensorStatus(zoneTuples: Array<[number, string]>): { [string]: boolean } {
  return zoneTuples.reduce((acc, value, index) => ({ ...acc, [`${index}`]: null }), {});
}

function getSensorStatus(zoneTuples: Array<[number, string]>, statuszone: number[] = []): { [string]: boolean } {
  return zoneTuples.reduce((acc, value, index) => ({ ...acc, [`${index}`]: statuszone[index] === 1 }), {});
}

function statusListener(zoneTuples: Array<[number, string]>) {
  class StatusEventEmitter extends EventEmitter {}

  const statusEventEmitter = new StatusEventEmitter();

  let prevStatus = {
    armed: isArmed(),
    sensors: getSensorStatus(zoneTuples),
  };
  let prevRawStatus = { statuszone: [], useraccess: [], alarms: [] };
  const intervalId = setInterval(async () => {
    let rawStatus;
    try {
      rawStatus = await getStatus();
    } catch (error) {
      console.error(error);
      statusEventEmitter.emit('error', error);
      return;
    }

    for (const key of ['statuszone', 'useraccess', 'alarms']) {
      if (!deepArrayEqual(prevRawStatus[key], rawStatus[key])) {
        console.log(`${key} changed`);
        console.log(prevRawStatus[key].join(','));
        console.log(rawStatus[key].join(','));
      }
    }

    const status = {
      armed: isArmed(rawStatus['useraccess']),
      sensors: getSensorStatus(zoneTuples, rawStatus['statuszone']),
    };

    if (prevStatus.armed !== status.armed) statusEventEmitter.emit('armedChanged', status.armed);
    for (let i = 0; i < zoneTuples.length; i += 1) {
      const index = `${i}`;
      if (prevStatus.sensors[index] !== status.sensors[index]) {
        statusEventEmitter.emit('sensorChanged', index, status.sensors[index]);
      }
    }

    prevRawStatus = rawStatus;
    prevStatus = status;
  }, 1000);

  return {
    on: (...args: any[]) => statusEventEmitter.on(...args),
    stop: () => clearInterval(intervalId),
  };
}

module.exports = {
  statusListener,
};
