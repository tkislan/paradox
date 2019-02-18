// @flow

const axios = require('axios');

const { HOSTNAME } = require('../config');

const AREA = '00';
const ARM = 'r';
const DISARM = 'd';

async function arm() {
    const params = { area: AREA, value: ARM };
    await axios({ url: `http://${HOSTNAME}/statuslive.html`, params  });
}

async function disarm() {
  const params = { area: AREA, value: DISARM };
  await axios({ url: `http://${HOSTNAME}/statuslive.html`, params  });
}

module.exports = {
  arm,
  disarm,
};
