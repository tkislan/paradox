'use strict';

const EventEmitter = require('events');

const { getStatus } = require('./api/status');
const { deepArrayEqual } = require('./util');

const DISARMED_STATUS = 1;
const ARMED_STATUS = 2;
const ARMING_STATUS = 7;


/** @param {number[]} [useraccess] */
function isArmed(useraccess) {
  if (!useraccess) return null;
  // @ts-expect-error parseInt stringifies the array ("2,1" -> 2), so only the first area counts.
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

/**
 * @param {Array<[number, string]>} zoneTuples
 * @returns {{ [key: string]: boolean }}
 */
function initSensorStatus(zoneTuples) {
  return zoneTuples.reduce((acc, value, index) => ({ ...acc, [`${index}`]: null }), {});
}

/**
 * @param {Array<[number, string]>} zoneTuples
 * @param {number[]} [statuszone]
 * @returns {{ [key: string]: boolean }}
 */
function getSensorStatus(zoneTuples, statuszone = []) {
  return zoneTuples.reduce((acc, value, index) => ({ ...acc, [`${index}`]: statuszone[index] === 1 }), {});
}

/** @param {Array<[number, string]>} zoneTuples */
function statusListener(zoneTuples) {
  class StatusEventEmitter extends EventEmitter {}

  const statusEventEmitter = new StatusEventEmitter();

  let prevStatus = {
    armed: isArmed(),
    sensors: getSensorStatus(zoneTuples),
  };
  statusEventEmitter.emit('armedChanged', prevStatus.armed);
  for (let i = 0; i < zoneTuples.length; i += 1) {
    const index = `${i}`;
    statusEventEmitter.emit('sensorChanged', index, prevStatus.sensors[index]);
  }
  
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
    on: /** @param {[string | symbol, (...args: any[]) => void]} args */ (...args) => statusEventEmitter.on(...args),
    stop: () => {
      clearInterval(intervalId);
      statusEventEmitter.removeAllListeners();
    },
  };
}

module.exports = {
  statusListener,
};
