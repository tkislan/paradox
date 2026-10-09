import { HTML, ZONE_SLOTS, zones } from '../process.ts';

// A CONNACK with return code 4 (bad credentials), as a broker would have to forge it on a live connection.
export const FORGED_CONNACK_BAD_CREDENTIALS = [0x20, 0x02, 0x00, 0x04];

const ENV_NAMES = ['HOSTNAME', 'USERNAME', 'PASSWORD', 'PORT', 'MQTT_HOSTNAME', 'MQTT_PORT', 'MQTT_USERNAME', 'MQTT_PASSWORD'];

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

export const KEEP_ALIVE_ROWS = [
  { name: 'healthy panel', failFirstKeepAlive: false },
  { name: 'first keep-alive answered with HTTP 500', failFirstKeepAlive: true },
];

export const POLL_FAILURES = [
  { name: 'panel goes away', stderrIncludes: 'ECONNREFUSED', pollsReachingPanel: 0, panel: {}, breakPanel: (panel) => panel.stop() },
  { name: 'panel answers HTTP 500', stderrIncludes: 'Request failed with status code 500', pollsReachingPanel: 1, panel: {}, breakPanel: (panel) => panel.respondWith('/statuslive.html', { status: 500, headers: HTML, body: 'busy' }) },
  { name: 'session expires and the panel serves the login page', stderrIncludes: "Regex didn't match the value", pollsReachingPanel: 1, panel: { requireLogin: true }, breakPanel: (panel) => panel.expireSession() },
];
