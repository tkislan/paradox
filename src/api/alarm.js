'use strict';

const axios = require('./http_client');

const { HOSTNAME } = require('../config');

const AREA = '00';
const ARM = 'r';
const DISARM = 'd';

// Assumed, never captured: without a session the panel answers with its login page and HTTP 200.
const LOGIN_PAGE_RE = /loginaff\(/;

/** @param {string} value */
async function sendCommand(value) {
  const params = { area: AREA, value };
  const response = await axios({ url: `http://${HOSTNAME}/statuslive.html`, params });
  if (LOGIN_PAGE_RE.test(response.data)) throw new Error('Command answered with the login page');
}

async function arm() {
  await sendCommand(ARM);
}

async function disarm() {
  await sendCommand(DISARM);
}

module.exports = {
  arm,
  disarm,
};
