const got = require('got');
const fs = require('fs');

const { HOSTNAME, USERNAME, PASSWORD } = require('../config');
const { keeplowbyte, hex_md5, rc4 } = require('../paradox');
const { sleep } = require('../util');

const LOGIN_SESSION_VALUE_RE = /loginaff\("([\w]+)"/m;

function encryptCredentials(sessionValue) {
  const password = hex_md5(keeplowbyte(PASSWORD)) + sessionValue;
  const passwordHash = hex_md5(password);
  const usernameHash = rc4(password, USERNAME);
  return [usernameHash, passwordHash];
}

async function getLogin() {
  const response = await got(`http://${HOSTNAME}/login.html`);
  return response.body;
}

async function getLoginPage() {
  const response = await got(`http://${HOSTNAME}/login_page.html`);
  return response.body;
}

// function getLoginPage() {
//   return new Promise((resolve, reject) => {
//     fs.readFile("./tests/data/login_page.html", "utf8", function(err, data) {
//       if (err) reject(err);
//       else resolve(data.toString());
//     });
//   });
// }

function getSessionValue(loginPage) {
  const match = LOGIN_SESSION_VALUE_RE.exec(loginPage);
  if (!match) throw Error('Session value not found in login page');
  return match[1];
}

async function createSession(username, password) {
  const searchParams = new URLSearchParams([['u', username], ['p', password]]);
  const headers = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate',
    'Accept-Language': 'en-GB,en;q=0.9,en-US;q=0.8,sk;q=0.7',
    'Connection': 'keep-alive',
    'Referer': `http://${HOSTNAME}/login.html`,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36',
  };
  const response = await got(`http://${HOSTNAME}/default.html`, { searchParams, headers });
  console.log(response.request);
  console.log(response.body);
}

async function login() {
  console.log(await getLogin());
  const loginPage = await getLoginPage();
  const sessionValue = getSessionValue(loginPage);
  await sleep(5000);
  console.log(`Session value: ${sessionValue}`);
  const [username, password] = encryptCredentials(sessionValue, USERNAME, PASSWORD);
  await createSession(username, password);
}


async function logout() {
  const response = await got(`http://${HOSTNAME}/logout.html`);
  console.log(response);
};

module.exports = {
  encryptCredentials,
  login,
  logout,
};
