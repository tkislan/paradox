const mqtt = require('mqtt');

const { arm, disarm } = require('./api/alarm');

const { MQTT_HOSTNAME, MQTT_PORT } = require('./config');

const COMMAND_ARM_TOPIC = 'paradox/command/arm';
const COMMAND_DISARM_TOPIC = 'paradox/command/disarm';

function getClient() {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtt://${MQTT_HOSTNAME}:${MQTT_PORT}`);
    client.on('connect', () => { resolve(client) });
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
    publish: (topic, message) => client.publish(topic, message),
  };
}

module.exports = {
  createMqttLink,
};
