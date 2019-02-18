// @flow

const { objectEntries } = require('./util');

const SIGNALS = {
  'SIGHUP': 1,
  'SIGINT': 2,
  'SIGTERM': 15
};


function setupSignalHandler(cb: () => Promise<any>) {
  objectEntries(SIGNALS).forEach(([signal, code]) => {
    const exit = () => {
      process.exit(128 + code);
    };

    process.on(signal, () => {
      console.log(`Process received a ${signal} signal`);
      cb().then(() => {
        exit();
      }, (error) => {
        console.error(error);
        exit();
      });

    });
  });
}

module.exports = {
  SIGNALS,
  setupSignalHandler,
};
