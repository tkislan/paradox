// @flow

const { sendKeepAlive } = require('./api/status');

function keepAlive() {
  const keepAliveIntervalId = setInterval(() => {
    sendKeepAlive().catch(console.error);
  }, 3000);

  return {
    stop: () => clearInterval(keepAliveIntervalId),
  };
}

module.exports = {
  keepAlive,
};
