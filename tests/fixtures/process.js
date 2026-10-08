// Literal copy of one golden row of spec/crypto.json (panel session value -> the u/p query the bridge must send).
export const golden = {
  session: '91AC25D06A0C26BA',
  username: 'user',
  password: '1234',
  u: 'EBA2095C',
  p: '82016AC9BD9B087D6C393B19C756B255',
};

export const MQTT_CREDENTIALS = { username: 'mqttuser', password: 'mqttpass' };

// Mosquitto answers every failed login with CONNACK 5; this is how mqtt.js words it:
export const NOT_AUTHORIZED = 'Connection refused: Not authorized';

export const HTML = { 'Content-Type': 'text/html' };

export const LOGIN_ATTEMPT_PATHS = ['/logout.html', '/login_page.html', '/default.html'];

export const ARM_LINE = 'GET /statuslive.html?area=00&value=r';

export const DISARM_LINE = 'GET /statuslive.html?area=00&value=d';

export const ZONE_SLOTS = 32;

export const zones = (...open) => Array.from({ length: ZONE_SLOTS }, (_, i) => (open.includes(i) ? 1 : 0));

// Real processes and containers on a busy machine: generous limits cost nothing while everything is fast.
export const TEST_TIMEOUT = 90000;

// Row "long username and password" of spec/crypto.json, so the panel accepts the login without the test hashing anything.
export const login = {
  session: 'A86572A01074210A',
  username: 'administrator-account-01',
  password: 'correct horse battery staple 42',
  u: '190B865D5E772853950CC680FD3CE2C420CDA7109E08B014',
  p: '86DEC7C0F4E24C250E6C0A1B9B45B404',
};

export const mqtt = { username: 'mqtt-admin-account', password: 'mqtt-secret-horse' };

export const panelAccepting = { sessionValue: login.session, credentials: { [login.session]: { u: login.u, p: login.p } } };

export const SIGNAL_ROWS = [
  { name: 'SIGHUP', signal: 'SIGHUP', code: 129 },
  { name: 'SIGINT', signal: 'SIGINT', code: 130 },
];
