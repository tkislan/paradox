const vm = require('vm');
const axios = require('axios');
const fs = require('fs');

const { HOSTNAME } = require('../config');

const STATUSZONE_VALUE_RE = /tbl_statuszone[ ]+=[ ]+(new Array\((?:\d,?)*\))/m;
const USERACCESS_VALUE_RE = /tbl_useraccess[ ]+=[ ]+(new Array\((?:\d,?)*\))/m;
const ALARMS_VALUE_RE = /tbl_alarmes[ ]+=[ ]+(new Array\((?:\d,?)*\))/m;


const DISARMED_STATUS = 1;
const ARMED_STATUS = 2;
const ARMING_STATUS = 7;

async function getStatusPage() {
  const response = await axios({ url: `http://${HOSTNAME}/statuslive.html` });
  return response.data;
}

// function getStatusPage() {
//   return new Promise((resolve, reject) => {
//     // fs.readFile("./tests/data/armed.html", "utf8", function(err, data) {
//     fs.readFile("./tests/data/unarmed.html", "utf8", function(err, data) {
//       if (err) reject(err);
//       else resolve(data.toString());
//     });
//   });
// }

function getValue(statusPage, regexp) {
  const match = regexp.exec(statusPage);
  if (!match) throw new Error('Invalid status page');

  const sandbox = Object.create(null);
  return vm.runInNewContext(match[1], sandbox);
}

async function sendKeepAlive() {
  const randomNumber = Math.random().toString().replace(",", ".").split(".")[1];
  const params = { msgid: 1, [randomNumber]: null };
  await axios({ url: `http://${HOSTNAME}/keep_alive.html`, params });
}

async function getParadoxStatus() {
  const statusPage = await getStatusPage();

  return [
    getValue(statusPage, STATUSZONE_VALUE_RE),
    getValue(statusPage, USERACCESS_VALUE_RE),
    getValue(statusPage, ALARMS_VALUE_RE),
  ];
}

function isArmed(useraccess) {
  if (!useraccess) return null;
  switch (parseInt(useraccess, 10)) {
      case ARMED_STATUS:
      case ARMING_STATUS:
        return true;
      case DISARMED_STATUS:
        return false;
      default:
        return null;
  }
}

async function getStatus() {
  const [statuszone, useraccess, alarms] = await getParadoxStatus();
  // TODO - parse binary status
  return {
    armed: isArmed(useraccess),
    raw: {
      statuszone,
      useraccess,
      alarms,
    },
  };
}

module.exports = {
  sendKeepAlive,
  getStatus,
};
