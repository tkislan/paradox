# paradox-bridge tests

Characterization suite for the bridge: it pins what the code does **today**, so a rewrite (the plan is a
native Python Home Assistant integration) can be checked against it. It never edits `src/`.

## Running

The suite is its own npm project (vitest needs Node >= 22; production stays on Node 10.14).

```sh
cd tests
nvm use            # tests/.nvmrc -> Node 24
npm ci
npm test           # starts the Mosquitto brokers, builds src/ with the repo's Babel, runs vitest with v8 coverage
```

**Docker is required**: the MQTT tests run against real Mosquitto brokers started from
`tests/docker-compose.yml` (24 isolated containers of `eclipse-mosquitto:2`, about 5 s to start; the first run
pulls the image). `npm test` starts them if needed and removes them afterwards. `PARADOX_KEEP_BROKERS=1` leaves
them running (watch mode, several runs in parallel); `MOSQUITTO_REPLICAS` changes their number. Runs never
recreate running containers, so after editing the compose file run `docker compose down` in `tests/` first.

About 915 tests, 65 s. In agent/CI environments vitest may pick a reporter that hides console output; use
`npx vitest run --reporter=default` to see whether a change made the suite noisy (it must stay silent).

`npm test` first compiles `src/` to `tests/.build/` (the same Babel output `npm run build` ships, plus
source maps so coverage maps back onto `src/`). The root project must have its dependencies installed
(`npm install` in the repo root) because the bridge `require`s axios, express and mqtt from there.

Set `PARADOX_BUILD_DIR=<absolute path>` to run against an existing build directory without rebuilding
(parallel runs, mutation checks). Set `PARADOX_NODE=<path to a node binary>` to run the child-process tests
(`system/process.test.js`) on another runtime, e.g. the production one:
`PARADOX_NODE=$HOME/.nvm/versions/node/v10.14.2/bin/node npx vitest run system/process.test.js`.

## Coverage

99.5 % of lines, 97.7 % of branches. The rest is dead code in `src/`: the `default:` case of the sensor handler
(`app.js:43`, the value is always a boolean) and `initSensorStatus` (`status_listener.js:26-28`, never called).
Everything else (`util.sleep`, the `playground.js` script, the shutdown-callback rejection path, ...) is covered.
`system/process.test.js` runs the bridge as a child process, which vitest's coverage cannot see; it adds
evidence about exit codes, real signals and the Node 10.14 runtime, not coverage numbers.

## Layout

| Path | What |
| --- | --- |
| `spec/*.json`, `spec/crypto_reference.py` | Language-neutral case tables and an independent Python reference. **This is the part to reuse from Python.** `crypto` (vectors), `util`, `config`, `status_pages` (panel page -> parsed status), `login_cases` (panel responses -> zones or error), `status_machine` (poll sequence -> events), `mqtt`, `system_scenarios` (whole-bridge timelines). |
| `data/*.html` | Real pages captured from a panel. Spec files reference them by path. |
| `mock_paradox.js` | Fake panel: the HTTP contract the bridge needs, as a pure `handle()` plus a loopback server. |
| `docker-compose.yml`, `mosquitto/mosquitto.conf`, `mosquitto.js` | Real Mosquitto brokers as test fixtures: lease, observation, users, TCP proxy for faults (see "MQTT tests" below). |
| `support.js` | Loader for the built bridge, env, console/exit/signal/timer helpers. |
| `unit/` | One module at a time, driven by `spec/` tables where the cases are data. |
| `wire/` | `api/*` and `mqtt_link` against the fake panel / a real broker; assertions on requests, messages and broker-side events. |
| `system/` | The whole bridge (`app.js`) in-process and as a child process. |

## Conventions

- **Pin current behavior.** A test asserts what the code does now. Bugs and quirks are pinned too, titled
  `KNOWN BUG KB-n: ...` (catalog below) and tagged `"known_bug": "KB-n"` in spec files. A port decides per
  entry whether to keep or fix the behavior; the catalog says what the sensible fix is.
- **Black box at the lowest observable boundary**: HTTP requests/responses, MQTT messages and broker events, REST responses,
  `process.exit` codes. No `vi.mock` of modules (it cannot intercept the CommonJS `require` graph and would
  tie tests to the implementation). Console output is not contractual; capture it to keep runs quiet.
- **Expected values are literals or `spec/` entries**, never computed by the code under test.
- **Data before code.** If a behavior is "input -> output", it is a row in `spec/<topic>.json`:
  `{ "name", ...inputs, "expected", "known_bug"?, "note"? }`. The JS test is a thin `it.each` loop, which is
  also what `pytest.mark.parametrize` over the same file looks like.
- **Time**: the bridge's own timers (1 s poll, 3 s keep-alive, 5 s MQTT connect timeout) run on a fake clock
  (`useFakeClock`); sockets are real. Wait for effects with `waitFor`; `settle()` is only for "nothing
  happened" assertions, and with a broker only after `broker.syncLog()` (the broker log lags the connection).
- **Isolation**: `setBridgeEnv()` before `loadBridge()` (config.js reads the environment once at require time).
  Harness objects register their own cleanup; process signal listeners need `isolateProcessListeners()`.

## MQTT tests: real Mosquitto

The bridge hard-codes its topics, so tests that run in parallel cannot share a broker. `leaseBroker()`
(`mosquitto.js`) gives a test exclusive use of one of the 24 compose replicas until the test ends (claims are
atomic directories in the OS temp dir, so parallel test files and processes cooperate); the broker is reset
afterwards. Mosquitto reports less than a hand-written fake could, so the harness reads what it can:

| Need | Where it comes from |
| --- | --- |
| Messages the bridge published (topic, payload, QoS, retain flag as set) | `broker.published`, via an MQTT 5 observer with retain-as-published; `broker.retained(topic)` is what a new subscriber gets |
| Connect (protocol level, clean session, keepalive, will), subscriptions with QoS, denied subscriptions, CONNACK codes, disconnects, client publishes | `broker.connects`, `subscriptions`, `deniedSubscriptions`, `connacks`, `disconnects`, `clientPublishes`: parsed from Mosquitto's log, which lags the connection. Always `waitFor`, and `await broker.syncLog()` before asserting that something did *not* happen |
| Credentials | never in the broker log. `broker.addUser()` creates (through the dynamic security plugin) the account the test expects the bridge to authenticate as; success is the evidence. A refused login is CONNACK 5, never 4. `proxy.connects` shows what was sent |
| Other clients, kicked sessions, users that may not subscribe | `broker.publish()`, `broker.kick()`, `broker.addUser({ subscribe: false })` |
| Faults Mosquitto cannot produce (refused or silent connections, forged CONNACK, malformed bytes, cut sockets) | `broker.proxy()`: a TCP relay in front of the broker with `stop()`/`start(port)`, `blackhole()`, `replyWith(bytes)`, `inject(bytes)`, `dropConnections()`, `accepted`, `connects` |

The harness's own MQTT client (the `mqtt5` alias of `mqtt@5`; the bridge keeps using the root's `mqtt@2`, which
`unit/dependencies.test.js` guards) has no keepalive or reconnect timers, so the fake clock cannot freeze it.
`vitest -t` matches only the first 40 characters of a `$title` test name.

## Porting to Python

Start with the data that has no framework in it: `crypto.json` (vectors, two of them published by other
projects), then the parsing tables (`status_pages`, `login_cases`), then `status_machine` and
`system_scenarios`. Caveats when reading the tables:

- Rows with `"known_bug"` carry today's (wrong) result as `expected`; they mark decisions, not behavior to copy.
- Rows with `"js_only"` describe JavaScript semantics (`vm` evaluation, `NaN`, octal literals, cross-realm arrays).
- Error strings that come from axios or V8 (`Request failed with status code 500`, `socket hang up`) are not
  portable; only the fact of failing is. The bridge's own messages (`Login failed`, ...) are.
- Rows that count dials or build URLs (`spec/mqtt.json`) only matter for a port that builds an MQTT URL.

| JS | Python |
| --- | --- |
| `spec/*.json` + `it.each` | the same files + `pytest.mark.parametrize` |
| `crypto_reference.py` | start of the client library; `python3 -I spec/crypto_reference.py` checks all vectors |
| `FakePanel.handle(request)` | an `aioclient_mock` callback or `aiohttp` test server around the same function |
| `FakePanel.requestLines` assertions | the exact URLs the client must request, in order |
| Mosquitto fixtures | only if the port keeps MQTT; Home Assistant has its own MQTT test helpers (`mqtt_mock`). The `mqtt.json` rows describe outcomes, not packets |

## Mutation checks

A test is only worth keeping if a realistic bug breaks it. To check by hand:

```sh
cd tests
cp -r .build .mutants/m1                      # .mutants/ is git-ignored; it must live inside the repo so axios etc. resolve
$EDITOR .mutants/m1/util.js                   # flip a branch, change a constant, drop a statement
PARADOX_KEEP_BROKERS=1 PARADOX_BUILD_DIR=$PWD/.mutants/m1 npx vitest run unit/util.test.js   # must fail
```

## Known bugs and quirks (pinned)

Each row is pinned by tests titled `KNOWN BUG KB-n: ...` and by spec rows with `"known_bug": "KB-n"`.
"Port" is a suggestion, not something the tests assert.

| ID | What the code does today | Pinned in | Port |
| --- | --- | --- | --- |
| KB-1 | `iterateTuples` yields only `ceil(n/4)` of the `n/2` zone pairs, so only zones 1-16 of 32 are ever seen (invisible on the captured panel: six zones) | `spec/util.json`, `login_cases.json` | all zones |
| KB-2 | Sensors are identified by their position in the *filtered* zone list; the enabled flags decide how many sensors exist, never which ones. `paradox/sensor/<position>` therefore reads `statuszone[position]` | `status_machine.json`, `system_scenarios.json` | key by real zone number |
| KB-3 | Never logs out: the shutdown handler returns the `logout` function without calling it, and no failure path logs out either. Only the next start's best-effort logout frees the (single) panel session | `wire/login.test.js`, `system_scenarios.json` | log out on unload |
| KB-4 | Startup events are emitted before anyone can listen. Initial state is assumed (armed unknown, all sensors closed), so only *differences* are published after a start: closed sensors publish nothing and retained topics keep stale values | `status_machine.json`, `system_scenarios.json` | publish the full state at start |
| KB-5 | `retry` ignores its wait time: the index page is requested up to 11 times back to back. Only failed requests are retried, not a 200 that does not parse | `util.json`, `login_cases.json` | back off |
| KB-6 | `deepArrayEqual` is shallow and never equal for `NaN` (only affects log output) | `util.json` | - |
| KB-7 | `removeAllListeners(['connect','error'])` takes an array and removes nothing, so the pre-connect handlers stay: a later client error is logged by the old handler and exits | `wire/mqtt_link.test.js` | - |
| KB-8 | MQTT credentials go into `mqtt://user:pass@host:port` unescaped: a `:` inside or at the start of the password shifts the split, an empty password becomes username `user:` with no password, `/ # ?` turn the username into the host, a malformed `%` throws | `spec/mqtt.json` | pass credentials as fields |
| KB-9 | The keep-alive's random cache-buster is dropped by axios (`null` value): the wire request is `GET /keep_alive.html?msgid=1` | `status_pages.json`, `status_machine.json` | check against a real panel |
| KB-10 | Zone names must match `[\w ]+` (ASCII, no hyphen, not empty), also on disabled slots; one accented name makes login fail with "Regex didn't match the value" | `login_cases.json`, `util.json` | parse leniently |
| KB-11 | The title regex does not cross newlines, so a pretty-printed page never matches and the error is the copy-pasted "Session value not found in login page". The captured `login_page.html` is multi-line, so wrong credentials surface that way and "Login failed" is practically unreachable | `login_cases.json`, `wire/login.test.js` | real HTML parsing |
| KB-12 | No session recovery: the first failed poll (HTTP error, refused connection, or the login page after the session expired) ends the bridge with exit 1 and relies on Docker to restart it. The listener itself recovers on the next good poll | `status_machine.json`, `system_scenarios.json` | detect expiry, re-login |
| KB-13 | No HTTP timeouts and no in-flight guard: a hung panel hangs every call, polls overlap, a late stale response overwrites newer state | `status_pages.json`, `status_machine.json`, `wire/*` | timeouts, one request at a time |
| KB-14 | `arm`/`disarm` ignore the response: any 2xx (including the login page after expiry) is success | `status_pages.json`, `wire/alarm.test.js` | verify the state change |
| KB-15 | Alarm and trouble tables are never parsed (`alarms` is always `[0]`) | `status_pages.json` | parse them |
| KB-16 | Any payload on `paradox/command/arm|disarm` triggers the command | `spec/mqtt.json`, `system_scenarios.json` | validate payload |
| KB-17 | The 5 s connect timeout rejects but never ends the MQTT client, which keeps reconnecting | `wire/mqtt_link.test.js` | - |
| KB-18 | Only area 1 exists: `useraccess[0]`, command `area=00`, and the `tbl_zone` flag (really an area bitmask, see below) is compared with `== 1`, dropping zones of area 2 or of both | `login_cases.json`, `status_machine.json` | all areas |
| KB-19 | The REST API (`GET /status`, `POST /arm`, `POST /disarm`) has no authentication and listens on all interfaces | `system_scenarios.json` | - |
| KB-20 | Config error text is `Missing enviromnent variable: <KEY>` (sic) | `spec/config.json` | - |
| KB-21 | Only zone code `1` is "open"; `4` (open+trouble), `6` (open+memory, zone 5 of the captured `unarmed.html`) and `2` (alarm) read as closed | `status_machine.json` | map all codes |
| KB-22 | Only `useraccess` 1, 2, 7 are mapped (7 = exit delay counts as armed); stay, sleep, in alarm, entry delay, ready, ... become "unknown" and publish nothing, so an alarm is never reported | `status_machine.json` | map all codes |
| KB-23 | `tbl_* = new Array(n)` with one number is `n` empty slots, not `[n]` | `status_pages.json`, `util.test.js` | parse literals |
| KB-24 | An unparsable `MQTT_PORT` silently becomes 1883; above 65535 it rejects with a RangeError | `spec/mqtt.json` | validate |
| KB-25 | `PORT` is not validated: out of range exits 1 after login and the MQTT connect; non-numeric makes Express listen on a Unix socket of that name in the working directory | `system/process.test.js` | validate |
| KB-26 | `MQTT_HOSTNAME` is pasted unescaped into the URL | `spec/mqtt.json` | - |
| KB-27 | An error in the poll callback (no `'error'` listener, after `stop()`, or a throwing listener) is an unhandled promise rejection | `unit/status_listener.test.js` | - |
| KB-28 | The keep-alive ignores its response, like `arm` | `status_pages.json`, `status_machine.json` | - |
| KB-29 | Any broker connection loss after startup exits the process | `wire/mqtt_link.test.js` | reconnect |
| KB-30 | A refused subscription (SUBACK 0x80) is never noticed | `wire/mqtt_link.test.js` | - |
| KB-31 | The retain flag of inbound commands is ignored, so a retained command is executed on every start | `wire/mqtt_link.test.js` | - |
| KB-32 | No MQTT Last Will / availability topic | `wire/mqtt_link.test.js` | publish availability |
| KB-33 | Shutdown does not disconnect from MQTT | `system/app.test.js` | - |
| KB-34 | An unreachable broker only shows up as `MQTT connect timeout` after 5 s (mqtt 2.18 swallows socket errors) | `wire/mqtt_link.test.js` | - |
| KB-35 | A failed login logs the whole axios error, including the hashed credentials | `system/app.test.js` | redact |
| KB-36 | A failed parse logs the whole page and the pattern | `wire/status.test.js` | - |
| KB-37 | `EADDRINUSE` on the REST port is an uncaught exception | `system/app.test.js` | - |
| KB-38 | Shutdown waits for open connections and in-flight requests; repeated signals do not force it | `system/process.test.js` | - |
| KB-39 | Panel tables are evaluated as JavaScript (`vm`): `1+2` is computed, `010` is octal, a comma-less list reaches the interpreter; the null-prototype sandbox is the only barrier | `spec/util.json`, `status_pages.json` | parse literals only |
| KB-40 | The `tbl_zone` flag must be a single digit, otherwise login fails entirely | `login_cases.json` | - |
| KB-41 | An empty environment variable counts as set | `system/process.test.js` | - |
| KB-42 | The signal handler has no re-entrancy guard: a second signal runs the shutdown again | `unit/signal.test.js` | - |
| KB-43 | A shutdown callback that throws or returns a non-promise crashes with exit 1 | `unit/signal.test.js` | - |

Not tests, only observations: the config names `HOSTNAME`, `USERNAME` and `PASSWORD` collide with
variables shells and containers set (Docker sets `HOSTNAME` to the container id, so a forgotten value never
triggers the config error there), and the session value is written to the log.

## Panel facts the bridge gets wrong or ignores

Read from the panel's own JavaScript (`commun.js`, `langue.js`, `agaxreq.js` as shipped in
tracstarr/ParadoxAlarmControl) while researching this suite; not verified against your panel. Re-capture
before trusting them for the port.

- `tbl_statuszone`: 0 closed, 1 open, 2 in alarm, 3 closed+trouble, 4 open+trouble, 5 closed+memory, 6 open+memory, 7 bypassed.
  The bridge treats only `1` as open, so `tests/data/unarmed.html` (zone 5 = 6, open+memory) publishes OFF for an open zone.
- `tbl_useraccess`: 0 area unused, 1 disarmed, 2 armed, 3 in alarm, 4 sleep, 5 stay, 6 entry delay, 7 exit delay, 8 ready, 9 not ready, 10 instant.
  The bridge maps 2 and 7 to armed, 1 to disarmed and everything else (including *in alarm*) to "unknown", which publishes nothing.
  `tests/data/armed.html` was captured during exit delay (7).
- `tbl_zone`: the first number of each pair is an **area bitmask**, not an enabled flag. The bridge keeps `== 1`, i.e. only zones of area 1 alone.
- Commands: `GET /statuslive.html?area=NN&value=X`, NN a two-digit 0-based area (`99` = all), X one of `r` arm, `f` force, `s` stay, `i` instant, `p` sleep, `d` disarm.
- One session at a time, 10 minute lockout after repeated failed logins, the browser keeps alive every 5 s (the bridge: 3 s).
- Firmware: scraping works on IP100 and IP150 below 4.x. IP150 5.x answers `default.html` but returns 404 for `statuslive.html`; a port should detect that. The forward path for those panels is the binary protocol on TCP 10000 (see the PAI project).
- Third-party code for this protocol is GPL or non-commercial licensed in part (maisken, a-lurker); reimplement from behavior, do not copy.

## What the fake panel invents

Responses nobody captured, so tests must not depend on their bodies: the failed-login page (the fake returns
the login page), the response to arm/disarm and keep-alive, what an expired session returns (`requireLogin`
makes the fake answer the login page), the "busy" page when another session is open, the real `useraccess`
transitions while arming. Capturing these from the real panel is the first step of the port.
