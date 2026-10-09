'use strict';

const ENV_VARIABLES = ['HOSTNAME', 'USERNAME', 'PASSWORD', 'PORT', 'MQTT_HOSTNAME', 'MQTT_PORT', 'MQTT_USERNAME', 'MQTT_PASSWORD'];

/**
 * @typedef {object} EnvironmentVariables
 * @property {string} HOSTNAME
 * @property {string} USERNAME
 * @property {string} PASSWORD
 * @property {string} PORT
 * @property {string} MQTT_HOSTNAME
 * @property {string} MQTT_PORT
 * @property {string} MQTT_USERNAME
 * @property {string} MQTT_PASSWORD
 */

/** @returns {EnvironmentVariables} */
function parseEnvironment() {
  return ENV_VARIABLES.reduce((acc, key) => {
    const value = process.env[key];
    if (value == null) throw new Error(`Missing enviromnent variable: ${key}`);

    return { ...acc, [key]: value };
  }, /** @type {EnvironmentVariables} */ ({}));
}

module.exports = parseEnvironment();
