'use strict';

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
const SENSOR_MOTION_TOPIC_TEMPLATE = (index) => `paradox/sensor/${index}`;
// Any failed poll earns a re-login, since what the panel answers once a session expired was never captured. At most
// one per interval: each login ends whatever session the panel holds, and it holds only one.
const RELOGIN_MIN_INTERVAL = 60 * 1000; // in milliseconds

async function run() {
  const { zoneTuples } = await login();

  const mqttLink = await createMqttLink();

  const keepAliveWorker = keepAlive();
  const statusEvents = statusListener(zoneTuples);

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

  statusEvents.on('sensorChanged', (index, motionDetected) => {
    switch (motionDetected) {
      case true:
        return mqttLink.publish(SENSOR_MOTION_TOPIC_TEMPLATE(index), 'ON', { retain: true });
      case false:
        return mqttLink.publish(SENSOR_MOTION_TOPIC_TEMPLATE(index), 'OFF', { retain: true });
      default:
        console.log(`Unknown sensor status: ${motionDetected}`);
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

  function exitHandler() {
    keepAliveWorker.stop();
    statusEvents.stop();

    return Promise.all([
      new Promise((resolve) => server.close(resolve)),
      logout(),
    ]);
  }

  let reloggingIn = false;
  let lastReloginAt = -Infinity;
  statusEvents.on('error', (error) => {
    console.error(error);
    // Polls keep failing until the new session exists.
    if (reloggingIn) return;
    // Failing again so soon means a new session does not help; exit and leave it to the restart policy.
    if (Date.now() - lastReloginAt < RELOGIN_MIN_INTERVAL) return process.exit(1);
    reloggingIn = true;
    lastReloginAt = Date.now();
    login().then(() => { reloggingIn = false; }, (loginError) => {
      console.error(loginError);
      process.exit(1);
    });
  });
  setupSignalHandler(exitHandler);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});





