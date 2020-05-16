// @flow

const ENV_VARIABLES = ['HOSTNAME', 'USERNAME', 'PASSWORD', 'PORT', 'MQTT_HOSTNAME', 'MQTT_PORT'];

type EnvironmentVariables = {
  HOSTNAME: string,
  USERNAME: string,
  PASSWORD: string,
  PORT: string,
  MQTT_HOSTNAME: string,
  MQTT_PORT: string,
  MQTT_USERNAME: string,
  MQTT_PASSWORD: string,
};

function parseEnvironment(): EnvironmentVariables {
  return ENV_VARIABLES.reduce((acc, key) => {
    const value = process.env[key];
    if (value == null) throw new Error(`Missing enviromnent variable: ${key}`);

    return { ...acc, [key]: value };
  }, {});
}

module.exports = parseEnvironment();
