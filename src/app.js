const express = require('express');

const { login, logout } = require('./api/login');
const { getStatus, sendKeepAlive } = require('./api/status');
const { arm, disarm } = require('./api/alarm');
const { PORT } = require('./config');
const { setupSignalHandler } = require('./signal');

login().catch(error => {
  console.error(error);
  process.exit(1);
});

// const keepAliveIntervalId = setInterval(() => {
//   sendKeepAlive().catch(console.error);
// }, 3000);


// function deepArrayEqual(a, b) {
//   if (a.length !== b.length) return false;

//   for (let i = 0; i < a.length; i++) {
//     if (a[i] !== b[i]) return false;
//   }
//   return true;
// }

// let prevStatus = { statuszone: [], useraccess: [], alarms: [] };
// setInterval(async () => {
//   const status = await getStatus();

//   const { statuszone, useraccess, alarms } = status;

//   for (const key of ['statuszone', 'useraccess', 'alarms']) {
//     if (!deepArrayEqual(prevStatus[key], status[key])) {
//       console.log(`${key} changed`);
//       console.log(prevStatus[key].join(','));
//       console.log(status[key].join(','));
//     }
//   }

//   prevStatus = status;
// }, 10000);

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
  arm.then(() => req.sendStatus(200), (error) => {
    console.error(error);
    res.status(500).json({ msg: error.message });
  });
});

app.post('/disarm', (req, res) => {
  disarm.then(() => req.sendStatus(200), (error) => {
    console.error(error);
    res.status(500).json({ msg: error.message });
  });
});

const server = app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));


setupSignalHandler((signal, code) => {
  // clearInterval(keepAliveIntervalId);

  return Promise.all([
    new Promise((resolve) => server.close(resolve)),
    logout,
  ]);
});
