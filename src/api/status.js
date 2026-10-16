'use strict';

const axios = require('./http_client');
const fs = require('fs');

const { HOSTNAME } = require('../config');
const { getJsValue } = require('../util');

const STATUSZONE_VALUE_RE = /tbl_statuszone[ ]+=[ ]+(new Array\((?:\d,?)*\))/m;
const USERACCESS_VALUE_RE = /tbl_useraccess[ ]+=[ ]+(new Array\((?:\d,?)*\))/m;
const ALARMS_VALUE_RE = /tbl_alarmes[ ]+=[ ]+(new Array\((?:"\d",?)*\))/m;
// Without a session the panel answers with its login page and HTTP 200.
const LOGIN_PAGE_RE = /loginaff\(/;


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

async function sendKeepAlive() {
  const response = await axios({ url: `http://${HOSTNAME}/keep_alive.html`, params: { msgid: 1 } });
  if (LOGIN_PAGE_RE.test(response.data)) throw new Error('Keep-alive answered with the login page');
}

async function getParadoxStatus() {
  const statusPage = await getStatusPage();

  return [
    getJsValue(statusPage, STATUSZONE_VALUE_RE),
    getJsValue(statusPage, USERACCESS_VALUE_RE),
    // getJsValue(statusPage, ALARMS_VALUE_RE),
    [0]
  ];
}

async function getStatus() {
  const [statuszone, useraccess, alarms] = await getParadoxStatus();
  return {
    statuszone,
    useraccess,
    alarms,
  };
}

module.exports = {
  sendKeepAlive,
  getStatus,
};
