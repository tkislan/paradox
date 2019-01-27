const axios = require('axios');
const fs = require('fs');

const { HOSTNAME, USERNAME, PASSWORD } = require('../config');
const { keeplowbyte, hex_md5, rc4 } = require('../paradox');
const { sleep } = require('../util');

const LOGIN_SESSION_VALUE_RE = /loginaff\("([\w]+)"/m;
const PAGE_TITLE_RE = /<head>.*<title>(.*)<\/title>.*<\/head>/m;

const headers = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate',
  'Accept-Language': 'en-GB,en;q=0.9,en-US;q=0.8,sk;q=0.7',
  'Connection': 'keep-alive',
  'Referer': `http://${HOSTNAME}/login.html`,
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36',
};

function encryptCredentials(sessionValue) {
  const password = hex_md5(keeplowbyte(PASSWORD)) + sessionValue;
  const passwordHash = hex_md5(password);
  const usernameHash = rc4(password, USERNAME);
  return [usernameHash, passwordHash];
}

async function getLoginPage() {
  const response = await axios({ url: `http://${HOSTNAME}/login_page.html`, headers });
  return response.data;
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
  const params = { u: username, p: password };
  const response = await axios({ url: `http://${HOSTNAME}/default.html`, params, headers });
  return response.data;
}

function getTitle(defaultPage) {
  const match = PAGE_TITLE_RE.exec(defaultPage);
  if (!match) throw Error('Session value not found in login page');
  return match[1];
}

async function login() {
  try {
    await logout();
  } catch (error) {
    console.warn('Logout before login failed');
  }
  const loginPage = await getLoginPage();
  const sessionValue = getSessionValue(loginPage);
  console.log(`Session value: ${sessionValue}`);
  const [username, password] = encryptCredentials(sessionValue, USERNAME, PASSWORD);
  const defaultPage = await createSession(username, password);
  const defaultPageTitle = getTitle(defaultPage);

  if (defaultPageTitle !== 'Paradox IP Module') throw new Error('Login failed');
}


async function logout() {
  await axios({ url: `http://${HOSTNAME}/logout.html` });
}

module.exports = {
  encryptCredentials,
  login,
  logout,
};
