const express = require('express');

const { login, logout } = require('./api/login');
const { getStatus } = require('./api/status');
const { arm, disarm } = require('./api/alarm');
const { keepAlive } = require('./keep_alive_worker');
const { statusListener } = require('./status_listener');
const { createMqttLink } = require('./mqtt_link');
const { PORT } = require('./config');
const { setupSignalHandler } = require('./signal');

const STATUS_ARMED_TOPIC = 'paradox/status/armed';

async function run() {
  await login();

  const mqttLink = await createMqttLink();

  const keepAliveWorker = keepAlive();
  const statusEvents = statusListener();

  statusEvents.on('armedChanged', (armed) => {
    switch (armed) {
      case true:
        return mqttLink.publish(STATUS_ARMED_TOPIC, 'ON', { retain: true });
      case false:
        return mqttLink.publish(STATUS_ARMED_TOPIC, 'OFF', { retain: true });
      case null:
        console.log('Unknown armed status');
    }
  });

  const app = express();

  app.get('/status', (req, res) => {
    getStatus().then((status) => {
      res.json(status);
    }, (error) => {
      console.error(error);
      res.status(500).json({ msg: error.message });
    });
  });

  app.post('/arm', (req, res) => {
    arm().then(() => res.sendStatus(200), (error) => {
      console.error(error);
      res.status(500).json({ msg: error.message });
    });
  });

  app.post('/disarm', (req, res) => {
    disarm().then(() => res.sendStatus(200), (error) => {
      console.error(error);
      res.status(500).json({ msg: error.message });
    });
  });

  const server = app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

  setupSignalHandler((signal, code) => {
    keepAliveWorker.stop();
    statusEvents.stop();

    return Promise.all([
      new Promise((resolve) => server.close(resolve)),
      logout,
    ]);
  });
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});





