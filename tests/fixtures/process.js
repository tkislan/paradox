// Literal copy of one golden row of spec/crypto.json (panel session value -> the u/p query the bridge must send).
export const golden = {
  session: '91AC25D06A0C26BA',
  username: 'user',
  password: '1234',
  u: 'EBA2095C',
  p: '82016AC9BD9B087D6C393B19C756B255',
};

export const MQTT_CREDENTIALS = { username: 'mqttuser', password: 'mqttpass' };

const ENV_NAMES = ['HOSTNAME', 'USERNAME', 'PASSWORD', 'PORT', 'MQTT_HOSTNAME', 'MQTT_PORT', 'MQTT_USERNAME', 'MQTT_PASSWORD'];

export const HTML = { 'Content-Type': 'text/html' };

export const LOGIN_ATTEMPT_PATHS = ['/logout.html', '/login_page.html', '/default.html'];

export const ARM_LINE = 'GET /statuslive.html?area=00&value=r';

export const DISARM_LINE = 'GET /statuslive.html?area=00&value=d';

const ZONE_SLOTS = 32;

export const zones = (...open) => Array.from({ length: ZONE_SLOTS }, (_, i) => (open.includes(i) ? 1 : 0));

const zoneCodes = (...codes) => Array.from({ length: ZONE_SLOTS }, (_, i) => codes[i] || 0);

// Scenario table: language-neutral, can move to spec/process.json when the Python suite needs it.
export const MISSING_ENV = [
  ...ENV_NAMES.map((name) => ({ name: `${name} missing`, missing: [name], reported: name })),
  { name: 'several missing: the first in declaration order is reported', missing: ['MQTT_PASSWORD', 'PORT'], reported: 'PORT' },
  { name: 'nothing set at all', missing: ENV_NAMES, reported: 'HOSTNAME' },
];

// First poll: the bridge assumes armed = unknown and every sensor closed, and only publishes differences from that.
const THREE_ZONES_FIRST_DISABLED = [[0, ' '], [1, 'Door'], [1, 'Window']];

export const FIRST_POLL = [
  { name: 'disarmed, all zones closed: only the armed topic gets OFF', useraccess: [1, 0], statuszone: zones(), published: ['paradox/status/armed OFF'] },
  {
    name: 'armed with zones 0 and 5 open: ON for the armed topic and the two open sensors, closed ones stay silent',
    useraccess: [2, 0],
    statuszone: zones(0, 5),
    published: ['paradox/status/armed ON', 'paradox/sensor/0 ON', 'paradox/sensor/5 ON'],
  },
  { name: 'arming (code 7) counts as armed', useraccess: [7, 0], statuszone: zones(), published: ['paradox/status/armed ON'] },
  { name: 'unknown area code (3): nothing is published', useraccess: [3, 0], statuszone: zones(), published: [] },
  { name: 'KB-18: only area 1 matters, area 2 armed does not make the bridge armed', useraccess: [1, 2], statuszone: zones(), published: ['paradox/status/armed OFF'] },
  {
    name: 'KB-2: with the first zone disabled, status entry 1 (the Door) is published as sensor 1, the position of the Window',
    zones: THREE_ZONES_FIRST_DISABLED,
    useraccess: [1, 0],
    statuszone: zones(1),
    published: ['paradox/status/armed OFF', 'paradox/sensor/1 ON'],
  },
  {
    name: 'KB-2: with the first zone disabled, the last zone (status entry 2) is never read',
    zones: THREE_ZONES_FIRST_DISABLED,
    useraccess: [1, 0],
    statuszone: zones(2),
    published: ['paradox/status/armed OFF'],
  },
  {
    name: 'KB-1: with 32 enabled zones only the first 16 are watched: status entry 15 is published, entries 16 and 20 are never read',
    zones: Array.from({ length: 32 }, (_, i) => [1, `Zone ${i + 1}`]),
    useraccess: [1, 0],
    statuszone: zones(10, 15, 16, 20),
    published: ['paradox/status/armed OFF', 'paradox/sensor/10 ON', 'paradox/sensor/15 ON'],
  },
  {
    name: 'KB-21: only status code 1 is an open zone, in alarm (2), trouble (3, 4), memory (5, 6) and bypassed (7) are reported as closed',
    useraccess: [1, 0],
    statuszone: zoneCodes(2, 3, 4, 5, 6, 7),
    published: ['paradox/status/armed OFF'],
  },
];

export const CONNECT_TIMEOUT_ROWS = [
  { name: 'nothing listening', nothingListening: true, connects: 0 },
  { name: 'broker accepts TCP but never answers CONNECT', broker: { silent: true }, connects: 1 },
];

export const KEEP_ALIVE_ROWS = [
  { name: 'healthy panel', failFirstKeepAlive: false },
  { name: 'first keep-alive answered with HTTP 500', failFirstKeepAlive: true },
];

export const SIGNAL_ROWS = [
  { name: 'SIGHUP', signal: 'SIGHUP', code: 129 },
  { name: 'SIGINT', signal: 'SIGINT', code: 130 },
];

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
