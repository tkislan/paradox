'use strict';

const axios = require('./http_client');
const fs = require('fs');

const { HOSTNAME } = require('../config');
const { getJsValue } = require('../util');

const STATUSZONE_VALUE_RE = /tbl_statuszone[ ]+=[ ]+(new Array\((?:\d,?)*\))/m;
const USERACCESS_VALUE_RE = /tbl_useraccess[ ]+=[ ]+(new Array\((?:\d,?)*\))/m;
const ALARMS_VALUE_RE = /tbl_alarmes[ ]+=[ ]+(new Array\((?:(?:"\d+"|\d+)(?:,(?:"\d+"|\d+))*,?)?\))/m;
const TROUBLES_VALUE_RE = /tbl_troubles[ ]+=[ ]+(new Array\((?:(?:"\d+"|\d+)(?:,(?:"\d+"|\d+))*,?)?\))/m;
// Assumed, never captured: without a session the panel answers with its login page and HTTP 200.
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

/**
 * Entries are 0-based indexes, per the panel's commun.js: areas in alarm index tbl_areanam and active troubles index
 * tbl_troublename, both on index.html. Every captured page has both tables; a page without one reads as empty.
 * @param {string} statusPage
 * @param {string} tableName
 * @param {RegExp} regexp
 * @returns {number[]}
 */
function getIndexList(statusPage, tableName, regexp) {
  if (!statusPage.includes(tableName)) return [];
  return getJsValue(statusPage, regexp).map(Number);
}

async function getParadoxStatus() {
  const statusPage = await getStatusPage();

  return [
    getJsValue(statusPage, STATUSZONE_VALUE_RE),
    getJsValue(statusPage, USERACCESS_VALUE_RE),
    getIndexList(statusPage, 'tbl_alarmes', ALARMS_VALUE_RE),
    getIndexList(statusPage, 'tbl_troubles', TROUBLES_VALUE_RE),
  ];
}

async function getStatus() {
  const [statuszone, useraccess, alarms, troubles] = await getParadoxStatus();
  return {
    statuszone,
    useraccess,
    alarms,
    troubles,
  };
}

module.exports = {
  sendKeepAlive,
  getStatus,
};
