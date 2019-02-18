// @flow

const mqtt = require('mqtt');

const { arm, disarm } = require('./api/alarm');

const { MQTT_HOSTNAME, MQTT_PORT } = require('./config');

const COMMAND_ARM_TOPIC = 'paradox/command/arm';
const COMMAND_DISARM_TOPIC = 'paradox/command/disarm';

function getClient() {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtt://${MQTT_HOSTNAME}:${MQTT_PORT}`);

    const timeoutId = setTimeout(() => reject(new Error('MQTT connect timeout')), 5000);

    client.on('connect', () => {
      clearTimeout(timeoutId);
      client.removeAllListeners(['connect', 'error']);
      console.log('MQTT client connected');

      client.on('close', () => { process.exit(1); });
      client.on('error', () => { process.exit(1); });

      resolve(client);
    });
    client.on('error', (error) => {
      clearTimeout(timeoutId);
      client.removeAllListeners(['connect', 'error']);
      console.error(error);
      reject(error);
    });
  });
}

function wrapPromise(p) {
  p.catch(error => {
    console.error(error);
  });
}

async function createMqttLink() {
  const client = await getClient();

  client.subscribe(COMMAND_ARM_TOPIC);
  client.subscribe(COMMAND_DISARM_TOPIC);

  client.on('message', (topic) => {
    switch (topic) {
      case COMMAND_ARM_TOPIC:
        wrapPromise(arm());
        break;
      case COMMAND_DISARM_TOPIC:
        wrapPromise(disarm());
        break;
    }
  });

  return {
    publish: (topic: string, message: any, options?: Object) => { console.log('publish', topic, message); client.publish(topic, message, options) },
  };
}

module.exports = {
  createMqttLink,
};
