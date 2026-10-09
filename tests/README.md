# paradox-bridge tests

Characterization suite for the bridge: it pins what the code does **today**, so a rewrite (the plan is a
native Python Home Assistant integration) can be checked against it. It never edits `src/`.

## Running

From the repository root (vitest is a dev dependency of the root project; Node 24 per `.nvmrc`):

```sh
nvm use
npm ci
docker compose -f tests/docker-compose.yml up --detach --wait   # the Mosquitto brokers, once
npm test           # runs vitest with v8 coverage
npx vitest run unit/util   # a subset: file name filters work from the root
```

**The brokers are a prerequisite**: the MQTT tests run against real Mosquitto brokers from
`tests/docker-compose.yml` (24 isolated containers of `eclipse-mosquitto:2`, about 5 s to start; the first run
pulls the image). The suite neither starts nor stops them, so parallel runs (watch mode, agents) share them;
`docker compose -f tests/docker-compose.yml down` removes them, and `MOSQUITTO_REPLICAS` changes their number.
Without them, every test that leases a broker fails with the command above.

The tests are TypeScript that vitest runs as is (it strips the types, nothing is compiled). `npm run typecheck`
checks them together with `src/`, with the same settings: `strict`, but unannotated parameters allowed (`any`).
`tests/package.json` marks them as ES modules, which they are under vitest.

About 730 tests, 50 s. `npx vitest run --exclude 'tests/known_bugs/**'` skips the 206 that pin a defect. In agent/CI
environments vitest may pick a reporter that hides console output; use `npx vitest run --reporter=default` to see
whether a change made the suite noisy (it must stay silent).

Tests load `src/` itself, through Node's own module loader (`vitest.config.mjs` hands `src/` to Node rather than
to vitest's loader). Modules without load-time state (`paradox.js`, `util.js`) are imported at the top of a test
file. The others are `require`d inside the test, after `setBridgeEnv()`: `config.js` reads the environment once
when it loads, and most tests point the bridge at their own fake panel. `support.ts` empties Node's module cache
for `src/` after every test. The bridge `require`s axios, express and mqtt from the root `node_modules`, i.e. the
versions production installs.

Set `PARADOX_NODE=<path to a node binary>` to run the child-process tests
(`system/process.test.ts`) on another runtime, e.g. an older Node line:
`PARADOX_NODE=$HOME/.nvm/versions/node/v22.23.3/bin/node npx vitest run system/process`.

## Coverage

98.2 % of lines, 97.7 % of branches. Dead code in `src/` is not covered: the `default:` case of the sensor handler
(`app.js:43`, the value is always a boolean) and `initSensorStatus` (`status_listener.js:32-34`, never called).
Deliberately without a test: the `playground.js` script and the shutdown-callback rejection path of `signal.js`
(lines 24-25). `config.js`, `mqtt_link.js`, `keep_alive_worker.js` and `signal.js` have no tests of their own, because
the Python port does not need them; the system tests only run them, so they show as covered even where no assertion
would notice a changed value.
`system/process.test.ts` runs the bridge as a child process, which vitest's coverage cannot see; it adds
evidence about exit codes and real signals, not coverage numbers.

## Layout

| Path | What |
| --- | --- |
| `spec/*.json`, `spec/crypto_reference.py` | Language-neutral case tables and an independent Python reference. **This is the part to reuse from Python.** `crypto` (vectors), `util`, `status_pages` (panel page -> parsed status), `login_cases` (panel responses -> zones or error), `status_machine` (poll sequence -> events), `system_scenarios` (whole-bridge timelines). |
| `spec/known_bugs/*.json` | The rows of those tables that pin a defect (`"known_bug"`), same groups and row format. A port can ignore them. |
| `data/*.html` | Real pages captured from a panel. Spec files reference them by path. |
| `mock_paradox.ts` | Fake panel: the HTTP contract the bridge needs, as a pure `handle()` plus a loopback server. |
| `docker-compose.yml`, `mosquitto/mosquitto.conf`, `mosquitto.ts` | Real Mosquitto brokers as test fixtures: lease, observation, users, TCP proxy for faults (see "MQTT tests" below). |
| `support.ts` | Env, the per-test reset of `src/` modules, console/exit/signal/timer helpers. |
| `helpers/`, `fixtures/` | Everything that is not a test case. `helpers/<area>.ts` holds the code a test file needs (world builders, request/outcome assertions, scenario interpreters, small constants) and `fixtures/<area>.ts` the scenario tables and shared data (`fixtures/known_bugs/` the ones only the known-bug tests use). Test files import from them and contain only `describe`/`it`. |
| `unit/` | One module at a time, driven by `spec/` tables where the cases are data. |
| `wire/` | `api/*` against the fake panel; assertions on the requests it receives and on what the calls return. |
| `system/` | The whole bridge (`app.js`) in-process and as a child process. |
| `known_bugs/` | The tests that pin a defect, one file per file of `unit/`, `wire/` and `system/` that has any, with the same `describe` names. A port can ignore the directory. |

## Conventions

- **Pin current behavior.** A test asserts what the code does now. Bugs and quirks are pinned too, titled
  `KNOWN BUG KB-n: ...` (catalog below) and tagged `"known_bug": "KB-n"` in spec files, but kept apart: tests in
  `known_bugs/`, rows in `spec/known_bugs/`, tables only they use in `fixtures/known_bugs/`; `unit/known_bug_layout.test.ts`
  fails when one turns up elsewhere. The program has run for years, so these are improvements to consider rather
  than requirements: everything outside those paths is what a port has to meet, and a port decides per entry whether
  to keep or fix the behavior (the catalog says what the sensible fix is). Some of them also pin a fact a port needs
  anyway (KB-20: a missing variable stops the start-up) that has no second copy outside `known_bugs/`, so read the
  catalog before skipping the directory.
- **Test files hold test cases only.** Setup, assertion helpers, scenario interpreters and data tables live in `helpers/` and `fixtures/` (one module per test file, plus a few shared ones: `outcomes`, `responses`, `panel_faults`), which is what a port re-creates as `conftest.py` and helper modules; the test files then translate one to one.
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
- **Isolation**: `setBridgeEnv()` before `require`-ing a module from `src/` (config.js reads the environment once at
  require time); each test gets fresh `src/` modules.
  Harness objects register their own cleanup; process signal listeners need `isolateProcessListeners()`.

## MQTT tests: real Mosquitto

The bridge hard-codes its topics, so tests that run in parallel cannot share a broker. `leaseBroker()`
(`mosquitto.ts`) gives a test exclusive use of one of the 24 compose replicas until the test ends (claims are
atomic directories in the OS temp dir, so parallel test files and processes cooperate); the broker is reset
afterwards. Mosquitto reports less than a hand-written fake could, so the harness reads what it can:

| Need | Where it comes from |
| --- | --- |
| Messages the bridge published (topic, payload, QoS, retain flag as set) | `broker.published`, via an MQTT 5 observer with retain-as-published; `broker.retained(topic)` is what a new subscriber gets |
| Connect (protocol level, clean session, keepalive, will), subscriptions with QoS, CONNACK codes, disconnects, client publishes | `broker.connects`, `subscriptions`, `connacks`, `disconnects`, `clientPublishes`: parsed from Mosquitto's log, which lags the connection. Always `waitFor`, and `await broker.syncLog()` before asserting that something did *not* happen |
| Credentials | never in the broker log. `broker.addUser()` creates (through the dynamic security plugin) the account the test expects the bridge to authenticate as; success is the evidence. A refused login is CONNACK 5, never 4. `proxy.connects` shows what was sent |
| Other clients, kicked sessions, other users | `broker.publish()`, `broker.kick()`, `broker.addUser()` |
| Faults Mosquitto cannot produce (refused or silent connections, malformed bytes, cut sockets) | `broker.proxy()`: a TCP relay in front of the broker with `stop()`/`start(port)`, `blackhole()`, `inject(bytes)`, `dropConnections()`, `accepted`, `connects` |

The harness's own MQTT client (the `mqtt5` alias of `mqtt@5`) has no keepalive or reconnect timers, so the fake clock
cannot freeze it. It must not be installed under the name `mqtt`: the bridge resolves `mqtt` and would
silently run against v5 instead of the production 2.18.8. Nothing guards this.
`vitest -t` matches only the first 40 characters of a `$title` test name.

## Porting to Python

Start with the data that has no framework in it: `crypto.json` (vectors, two of them published by other
projects), then the parsing tables (`status_pages`, `login_cases`), then `status_machine` and
`system_scenarios`. Caveats when reading the tables:

- Rows with `"known_bug"` (all in `spec/known_bugs/`, skip that directory) carry today's (wrong) result as `expected`;
  they mark decisions, not behavior to copy.
- Rows with `"js_only"` describe JavaScript semantics (`vm` evaluation, `NaN`, octal literals, cross-realm arrays).
- Error strings that come from axios or V8 (`Request failed with status code 500`, `socket hang up`) are not
  portable; only the fact of failing is. The bridge's own messages (`Login failed`, ...) are.

| JS | Python |
| --- | --- |
| `spec/*.json` + `it.each` | the same files + `pytest.mark.parametrize` |
| `crypto_reference.py` | start of the client library; `python3 -I spec/crypto_reference.py` checks all vectors |
| `FakePanel.handle(request)` | an `aioclient_mock` callback or `aiohttp` test server around the same function |
| `FakePanel.requestLines` assertions | the exact URLs the client must request, in order |
| Mosquitto fixtures | only if the port keeps MQTT; Home Assistant has its own MQTT test helpers (`mqtt_mock`) |

## Mutation checks

A test is only worth keeping if a realistic bug breaks it. To check by hand:

```sh
$EDITOR src/util.js                              # flip a branch, change a constant, drop a statement
npx vitest run unit/util                         # must fail
git restore src/util.js
```

## Known bugs and quirks (pinned)

Each row is pinned by tests titled `KNOWN BUG KB-n: ...` (files in `known_bugs/`, named like the test file they
were split from) and by spec rows with `"known_bug": "KB-n"` (files in `spec/known_bugs/`). "Port" is a suggestion,
not something the tests assert. The ids are not renumbered: KB-24, 26, 29-32, 34, 42 and 43 are missing because the
tests that pinned them (for `config.js`, `mqtt_link.js` and `signal.js`) were removed.

| ID | What the code does today | Pinned in | Port |
| --- | --- | --- | --- |
| KB-1 | `iterateTuples` yields only `ceil(n/4)` of the `n/2` zone pairs, so only zones 1-16 of 32 are ever seen (invisible on the captured panel: six zones) | `util.json`, `login_cases.json` | all zones |
| KB-2 | Sensors are identified by their position in the *filtered* zone list; the enabled flags decide how many sensors exist, never which ones. `paradox/sensor/<position>` therefore reads `statuszone[position]` | `status_machine.json`, `system_scenarios.json` | key by real zone number |
| KB-3 | Never logs out: the shutdown handler returns the `logout` function without calling it, and no failure path logs out either. Only the next start's best-effort logout frees the (single) panel session | `login.test.ts`, `system_scenarios.json` | log out on unload |
| KB-4 | Startup events are emitted before anyone can listen. Initial state is assumed (armed unknown, all sensors closed), so only *differences* are published after a start: closed sensors publish nothing and retained topics keep stale values | `status_machine.json`, `system_scenarios.json` | publish the full state at start |
| KB-5 | `retry` ignores its wait time: the index page is requested up to 11 times back to back. Only failed requests are retried, not a 200 that does not parse | `util.json`, `login_cases.json` | back off |
| KB-6 | `deepArrayEqual` is shallow and never equal for `NaN` (only affects log output) | `util.json` | - |
| KB-7 | `removeAllListeners(['connect','error'])` takes an array and removes nothing, so the pre-connect handlers stay: a later client error is logged by the old handler and exits | `app.test.ts`, `process.test.ts` | - |
| KB-8 | MQTT credentials go into `mqtt://user:pass@host:port` unescaped, so an empty password becomes username `user:` with no password, which the broker rejects with CONNACK 5 | `app.test.ts` | pass credentials as fields |
| KB-9 | The keep-alive's random cache-buster is dropped by axios (`null` value): the wire request is `GET /keep_alive.html?msgid=1` | `status_pages.json`, `status.test.ts` | check against a real panel |
| KB-10 | Zone names must match `[\w ]+` (ASCII, no hyphen, not empty), also on disabled slots; one accented name makes login fail with "Regex didn't match the value" | `login_cases.json`, `util.json` | parse leniently |
| KB-11 | The title regex does not cross newlines, so a pretty-printed page never matches and the error is the copy-pasted "Session value not found in login page". The captured `login_page.html` is multi-line, so wrong credentials surface that way and "Login failed" is practically unreachable | `login_cases.json`, `login.test.ts` | real HTML parsing |
| KB-12 | No session recovery: the first failed poll (HTTP error, refused connection, or the login page after the session expired) ends the bridge with exit 1 and relies on Docker to restart it. The listener itself recovers on the next good poll | `status_machine.json`, `system_scenarios.json` | detect expiry, re-login |
| KB-13 | No HTTP timeouts and no in-flight guard: a hung panel hangs every call, polls overlap, a late stale response overwrites newer state | `status_pages.json`, `status_machine.json`, `*.test.ts` | timeouts, one request at a time |
| KB-14 | `arm`/`disarm` ignore the response: any 2xx (including the login page after expiry) is success | `status_pages.json`, `alarm.test.ts` | verify the state change |
| KB-15 | Alarm and trouble tables are never parsed (`alarms` is always `[0]`) | `status_pages.json` | parse them |
| KB-16 | Any payload on `paradox/command/arm|disarm` triggers the command | `system_scenarios.json`, `process.test.ts` | validate payload |
| KB-17 | The 5 s connect timeout rejects but never ends the MQTT client, which keeps reconnecting | `system_scenarios.json` | - |
| KB-18 | Only area 1 exists: `useraccess[0]`, command `area=00`, and the `tbl_zone` flag (really an area bitmask, see below) is compared with `== 1`, dropping zones of area 2 or of both | `login_cases.json`, `status_machine.json` | all areas |
| KB-19 | The REST API (`GET /status`, `POST /arm`, `POST /disarm`) has no authentication and listens on all interfaces | `system_scenarios.json` | - |
| KB-20 | Config error text is `Missing enviromnent variable: <KEY>` (sic) | `system_scenarios.json`, `process.test.ts` | - |
| KB-21 | Only zone code `1` is "open"; `4` (open+trouble), `6` (open+memory, zone 5 of the captured `unarmed.html`) and `2` (alarm) read as closed | `status_machine.json` | map all codes |
| KB-22 | Only `useraccess` 1, 2, 7 are mapped (7 = exit delay counts as armed); stay, sleep, in alarm, entry delay, ready, ... become "unknown" and publish nothing, so an alarm is never reported | `status_machine.json` | map all codes |
| KB-23 | `tbl_* = new Array(n)` with one number is `n` empty slots, not `[n]` | `status_pages.json`, `util.test.ts` | parse literals |
| KB-25 | `PORT` is not validated: out of range exits 1 after login and the MQTT connect; non-numeric makes Express listen on a Unix socket of that name in the working directory | `process.test.ts` | validate |
| KB-27 | An error in the poll callback (no `'error'` listener, after `stop()`, or a throwing listener) is an unhandled promise rejection | `status_listener.test.ts` | - |
| KB-28 | The keep-alive ignores its response, like `arm` | `status_pages.json`, `status.test.ts` | - |
| KB-33 | Shutdown does not disconnect from MQTT | `app.test.ts` | - |
| KB-35 | A failed login logs the whole axios error, including the hashed credentials | `app.test.ts` | redact |
| KB-36 | A failed parse logs the whole page and the pattern | `status.test.ts` | - |
| KB-37 | `EADDRINUSE` on the REST port is an uncaught exception | `app.test.ts` | - |
| KB-38 | Shutdown waits for open connections and in-flight requests; repeated signals do not force it | `process.test.ts` | - |
| KB-39 | Panel tables are evaluated as JavaScript (`vm`): `1+2` is computed, `010` is octal, a comma-less list reaches the interpreter; the null-prototype sandbox is the only barrier | `util.json`, `status_pages.json` | parse literals only |
| KB-40 | The `tbl_zone` flag must be a single digit, otherwise login fails entirely | `login_cases.json` | - |
| KB-41 | An empty environment variable counts as set | `process.test.ts` | - |

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
