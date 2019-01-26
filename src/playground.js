const { encryptCredentials } = require('./api/login');

const sessionValue = 'A86572A01074210A';

console.log(encryptCredentials(sessionValue));
