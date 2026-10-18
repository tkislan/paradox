'use strict';

const EventEmitter = require('events');

const { getStatus } = require('./api/status');
const { deepArrayEqual } = require('./util');

// Names from the panel's own scripts; captured pages confirm only 1 and 7. In alarm (3) stays unknown: an alarm
// while disarmed is possible, and the armed topic has no value for it.
const DISARMED_STATUS = 1;
const ARMED_STATUS = 2;
const SLEEP_STATUS = 4;
const STAY_STATUS = 5;
const ENTRY_DELAY_STATUS = 6;
const ARMING_STATUS = 7;
const READY_STATUS = 8;
const NOT_READY_STATUS = 9;
const INSTANT_STATUS = 10;
// Zone codes from the panel's commun.js: 1 open, 2 in alarm, 4 open+trouble, 6 open+memory, 9 open (drawn like 4).
const OPEN_ZONE_STATUSES = [1, 2, 4, 6, 9];


/** @param {number[]} [useraccess] */
function isArmed(useraccess) {
  if (!useraccess) return null;
  // @ts-expect-error parseInt stringifies the array ("2,1" -> 2), so only the first area counts.
  switch (parseInt(useraccess, 10)) {
    case ARMED_STATUS:
    case SLEEP_STATUS:
    case STAY_STATUS:
    case ENTRY_DELAY_STATUS:
    case ARMING_STATUS:
    case INSTANT_STATUS:
      return true;
    case DISARMED_STATUS:
    case READY_STATUS:
    case NOT_READY_STATUS:
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
  // The first number of a pair is the zone's area bitmask (per the panel's commun.js); 0 is an unused slot.
  return zoneTuples.reduce((acc, [areas], slot) => (
    areas !== 0 ? { ...acc, [`${slot}`]: OPEN_ZONE_STATUSES.includes(statuszone[slot]) } : acc
  ), {});
}

/**
 * Sensors are keyed by zone slot, the position in tbl_zone and tbl_statuszone; unused slots get none.
 * @param {Array<[number, string]>} zoneTuples every slot of tbl_zone, unused ones included
 */
function statusListener(zoneTuples) {
  class StatusEventEmitter extends EventEmitter {}

  const statusEventEmitter = new StatusEventEmitter();

  let prevStatus = {
    armed: isArmed(),
    sensors: getSensorStatus(zoneTuples),
  };
  statusEventEmitter.emit('armedChanged', prevStatus.armed);
  for (const index of Object.keys(prevStatus.sensors)) {
    statusEventEmitter.emit('sensorChanged', index, prevStatus.sensors[index]);
  }
  
  let prevRawStatus = { statuszone: [], useraccess: [], alarms: [], troubles: [] };
  async function poll() {
    let rawStatus;
    try {
      rawStatus = await getStatus();
    } catch (error) {
      console.error(error);
      statusEventEmitter.emit('error', error);
      return;
    }

    for (const key of ['statuszone', 'useraccess', 'alarms', 'troubles']) {
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
    for (const index of Object.keys(status.sensors)) {
      if (prevStatus.sensors[index] !== status.sensors[index]) {
        statusEventEmitter.emit('sensorChanged', index, status.sensors[index]);
      }
    }

    prevRawStatus = rawStatus;
    prevStatus = status;
  }

  let polling = false;
  let paused = false;
  const intervalId = setInterval(() => {
    if (polling || paused) return;
    polling = true;
    // emit() throws for an 'error' nobody listens to (none at all after stop()) and rethrows a listener's exception.
    poll().catch(console.error).finally(() => { polling = false; });
  }, 1000);

  return {
    on: /** @param {[string | symbol, (...args: any[]) => void]} args */ (...args) => statusEventEmitter.on(...args),
    pause: () => { paused = true; },
    resume: /** @param {Array<[number, string]>} zones */ (zones) => {
      zoneTuples = zones;
      paused = false;
    },
    stop: () => {
      clearInterval(intervalId);
      statusEventEmitter.removeAllListeners();
    },
  };
}

module.exports = {
  statusListener,
};
