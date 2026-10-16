'use strict';

const axios = require('axios').default;

// axios waits forever by default, so a panel that stops answering would stall every caller without an error.
// Generous rather than tight: a failed poll ends the bridge (app.js).
module.exports = axios.create({ timeout: 10000 });
