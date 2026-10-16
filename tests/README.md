# paradox-bridge tests

Characterization suite for the bridge: it pins what the code does **today**, so a rewrite (the plan is a
native Python Home Assistant integration) can be checked against it. It never edits `src/`.

## Running

From the repository root (vitest is a dev dependency of the root project; Node 24 per `.nvmrc`):

```sh
nvm use
npm ci
docker compose -f tests/docker-compose.yml up --detach --wait   # the Mosquitto broker, once
npm test           # runs vitest with v8 coverage
npx vitest run unit/util   # a subset: file name filters work from the root
```

**The broker is a prerequisite**: the system tests run the bridge against a real Mosquitto from
`tests/docker-compose.yml` (one `eclipse-mosquitto:2` container, a few seconds to start; the first run pulls the
image). The suite neither starts nor stops it, so parallel runs (watch mode, agents) share it;
`docker compose -f tests/docker-compose.yml down` removes it. Without it, every test that needs the broker fails
with the command above.

The tests are TypeScript that vitest runs as is (it strips the types, nothing is compiled). `npm run typecheck`
checks them together with `src/`, with the same settings: `strict`, but unannotated parameters allowed (`any`).
`tests/package.json` marks them as ES modules, which they are under vitest.

About 650 tests, 10 s. `npx vitest run --exclude 'tests/known_bugs/**'` skips the 38 that pin a defect. In agent/CI
environments vitest may pick a reporter that hides console output; use `npx vitest run --reporter=default` to see
whether a change made the suite noisy (it must stay silent).

Tests load `src/` itself, through Node's own module loader (`vitest.config.mjs` hands `src/` to Node rather than
to vitest's loader). Modules without load-time state (`paradox.js`, `util.js`) are imported at the top of a test
file. The others are `require`d inside the test, after `setBridgeEnv()`: `config.js` reads the environment once
when it loads, and most tests point the bridge at their own fake panel. `support.ts` empties Node's module cache
for `src/` after every test. The bridge `require`s axios, express and mqtt from the root `node_modules`, i.e. the
versions production installs.

## Coverage

95.3 % of lines, 96.9 % of branches. Dead code in `src/` is not covered: the `default:` case of the sensor handler
(`app.js:46`, the value is always a boolean) and `initSensorStatus` (`status_listener.js:48-50`, never called).
Deliberately without a test, because a Home Assistant integration has nothing like them: the REST API (`app.js`),
signal handling (`signal.js`), the missing-variable check (`config.js`), MQTT connection failures (`mqtt_link.js`) and
the `playground.js` script. The shutdown handler in `app.js`, which a signal calls, is also what the bridge runs before
it exits when a new login did not help, and the `failures` scenarios test it there: it logs the panel session out, no
poll or keep-alive follows, and the exit waits for the logout. That it closes the REST server is not checked.
`config.js`, `mqtt_link.js`, `keep_alive_worker.js` and `signal.js` have no tests of their own; the system tests only
run them, so they show as covered even where no assertion would notice a changed value. For `signal.js` that is the
system tests' cleanup, which calls the SIGTERM listener the bridge registered.

## Layout

| Path | What |
| --- | --- |
| `spec/*.json`, `spec/crypto_reference.py` | Language-neutral case tables and an independent Python reference. **This is the part to reuse from Python.** `crypto` (vectors), `util`, `status_pages` (panel page -> parsed status), `login_cases` (panel responses -> zones or error), `status_machine` (poll sequence -> events), `system_scenarios` (whole-bridge timelines). |
| `spec/known_bugs/*.json` | The rows of those tables that pin a defect (`"known_bug"`), same groups and row format. A port can ignore them. |
| `spec/schemas.ts` | The format of every spec file as zod schemas. `loadSpec(name, schema)` parses a file with its schema, so tests get typed rows, and an unknown key or a wrong type in a spec file fails the load. |
| `data/*.html` | Real pages captured from a panel. Spec files reference them by path. |
| `mock_paradox.ts` | Fake panel: the HTTP contract the bridge needs, as a pure `handle()` plus a loopback server. |
| `docker-compose.yml`, `mosquitto/mosquitto.conf`, `mosquitto.ts` | The real Mosquitto broker and the tests' view of it: a topic prefix per test, what the bridge published, retained messages (see "MQTT tests" below). |
| `support.ts` | Env, the per-test reset of `src/` modules, console/exit/signal/timer helpers, the capture of unhandled rejections. |
| `helpers/`, `fixtures/` | Everything that is not a test case. `helpers/<area>.ts` holds the code a test file needs (world builders, request/outcome assertions, scenario interpreters, small constants) and `fixtures/<area>.ts` the scenario tables and shared data (`fixtures/known_bugs/` the ones only the known-bug tests use). Test files import from them and contain only `describe`/`it`. |
| `unit/` | One module at a time, driven by `spec/` tables where the cases are data. |
| `wire/` | `api/*` against the fake panel; assertions on the requests it receives and on what the calls return. |
| `system/` | The whole bridge (`app.js`), in-process. |
| `known_bugs/` | The tests that pin a defect, one file per file of `unit/`, `wire/` and `system/` that has any, with the same `describe` names. A port can ignore the directory. |

## Conventions

- **Pin current behavior.** A test asserts what the code does now. Bugs and quirks are pinned too, titled
  `KNOWN BUG KB-n: ...` (catalog below) and tagged `"known_bug": "KB-n"` in spec files, but kept apart: tests in
  `known_bugs/`, rows in `spec/known_bugs/`, tables only they use in `fixtures/known_bugs/`; `unit/known_bug_layout.test.ts`
  fails when one turns up elsewhere. The program has run for years, so these are improvements to consider rather
  than requirements: everything outside those paths is what a port has to meet, and a port decides per entry whether
  to keep or fix the behavior (the catalog says what the sensible fix is). One entry cannot be kept apart, because
  ordinary tests depend on it as well: KB-4 (after a start only differences are published, which most scenarios'
  first poll assumes). A port that fixes it updates those tests along with it.
- **Test files hold test cases only.** Setup, assertion helpers, scenario interpreters and data tables live in `helpers/` and `fixtures/` (one module per test file, plus a few shared ones: `outcomes`, `responses`, `panel_faults`), which is what a port re-creates as `conftest.py` and helper modules; the test files then translate one to one.
- **Black box at the lowest observable boundary**: HTTP requests/responses, MQTT messages, `process.exit` codes. No
  `vi.mock` of modules (it cannot intercept the CommonJS `require` graph and would tie tests to the implementation);
  the one hook into the bridge is the topic prefix its MQTT client gets (see "MQTT tests"). Console output is not contractual; capture it to keep runs quiet.
- **Expected values are literals or `spec/` entries**, never computed by the code under test.
- **Data before code.** If a behavior is "input -> output", it is a row in `spec/<topic>.json`:
  `{ "name", ...inputs, "expected", "known_bug"?, "note"? }`, and its format is in `spec/schemas.ts`. The JS test is a
  thin `it.each` loop, which is also what `pytest.mark.parametrize` over the same file looks like.
- **Time**: the bridge's own timers (1 s poll, 3 s keep-alive, 5 s MQTT connect timeout, 1 s between index page
  attempts at login, the 10 s timeout of every panel request) and its `Date` (a poll that fails less than 60 s after the
  last new login started, once that login has finished, ends the bridge instead of logging in again) run on a fake clock
  (`useFakeClock`); sockets are real. The bridge skips a tick while its last poll is unanswered, and in one long jump
  of the clock the sockets fall behind, so the scenario steps move it one poll interval at a time and let the panel
  answer in between.
  Wait for effects with `waitFor`; `settle()` is only for "nothing happened" assertions, and with a broker only after
  `broker.barrier()`.
- **Isolation**: `setBridgeEnv()` before `require`-ing a module from `src/` (config.js reads the environment once at
  require time); each test gets fresh `src/` modules.
  Harness objects register their own cleanup; process signal listeners need `isolateProcessListeners()`.

## MQTT tests: real Mosquitto

One broker serves every test. The bridge hard-codes its topics, so each test works under a topic prefix of its own
(`watchBroker()` in `mosquitto.ts`): `helpers/app.ts` wraps the bridge's MQTT client so that it publishes and
subscribes under the prefix and receives topics without it, and the harness reads and writes under the same prefix.
Parallel tests never see each other's messages or retained state, so nothing is reset between tests. The broker
accepts any client; the bridge's MQTT credentials are not checked.

| Need | Where it comes from |
| --- | --- |
| Messages the bridge published (topic, payload) | `broker.published`: a subscriber under the test's prefix; the command topics, where the harness publishes, are left out |
| Retained messages | `broker.retained(topic)`: what a new subscriber gets. The bridge publishes everything retained, so after every scenario each topic holds its last payload |
| Commands and other clients | `broker.publish(topic, payload)` |
| "Nothing more was published" | `await broker.barrier()` first: everything the broker forwarded before it has then arrived |

The harness's own clients (on the bridge's `mqtt` 2.18.8) have no keepalive or reconnect timers, so the fake clock
cannot freeze them. Not tested: how the bridge connects (protocol level, keepalive, client id, will, QoS, credentials)
and how it handles a broker that refuses, never answers or drops the connection.
`vitest -t` matches only the first 40 characters of a `$title` test name.

## Porting to Python

Start with the data that has no framework in it: `crypto.json` (vectors, two of them published by other
projects), then the parsing tables (`status_pages`, `login_cases`), then `status_machine` and
`system_scenarios`. Caveats when reading the tables:

- Rows with `"known_bug"` (all in `spec/known_bugs/`, skip that directory) carry today's (wrong) result as `expected`;
  they mark decisions, not behavior to copy.
- Rows with `"js_only"` (one `rc4` vector in `crypto.json`) depend on JavaScript semantics (`NaN`).
- `panel_requests_ignored` in a scenario step names requests the row takes no side on: the poll of a tick that falls
  on the same millisecond as a request timeout.
- Error strings that come from axios or V8 (`Request failed with status code 500`, `timeout of 10000ms exceeded`,
  `socket hang up`) are not portable; only the fact of failing is, and for a timeout when it fails. The bridge's own
  messages (`Login failed`, ...) are.
- Log the panel session out when the integration is unloaded, as the bridge's shutdown handler does. The suite checks
  that logout only where the bridge gives up after a new login did not help (`failures` in `system_scenarios.json`);
  the signal path, the counterpart of unloading, has no test, so a port that forgets the logout on unload still passes
  the suite.

| JS | Python |
| --- | --- |
| `spec/*.json` + `it.each` | the same files + `pytest.mark.parametrize` |
| `spec/schemas.ts` (zod) | pydantic models of the same files |
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
not something the tests assert. The ids are not renumbered: KB-1, 2, 3, 5, 9, 10, 11, 12, 13, 21, 23, 35, 39 and 40
are missing because they are fixed, and KB-7, 8, 17, 19, 20, 24 to 26, 29 to 34, 37, 38 and 41 to 43 because the
tests that pinned them were removed: those of `config.js`, `mqtt_link.js` and `signal.js`, the child-process tests, and
the MQTT connection, REST API, shutdown and configuration scenarios.

| ID | What the code does today | Pinned in | Port |
| --- | --- | --- | --- |
| KB-4 | Startup events are emitted before anyone can listen. Initial state is assumed (armed unknown, all sensors closed), so only *differences* are published after a start: closed sensors publish nothing and retained topics keep stale values | `status_machine.json`, `system_scenarios.json` | publish the full state at start |
| KB-6 | `deepArrayEqual` is shallow and never equal for `NaN` (only affects log output) | `util.json` | - |
| KB-14 | `arm`/`disarm` judge only the final response, after following redirects, and of the 2xx ones fail only on the login page (what an expired session gets): any other 2xx body, unrelated text or another page a redirect lands on, is success | `status_pages.json`, `alarm.test.ts` | verify the state change |
| KB-15 | Alarm and trouble tables are never parsed (`alarms` is always `[0]`) | `status_pages.json` | parse them |
| KB-16 | Any payload on `paradox/command/arm|disarm` triggers the command | `system_scenarios.json` | validate payload |
| KB-18 | The armed state and the commands cover area 1 only: the armed state is read from `useraccess[0]` alone (`parseInt` of the whole table) and commands always send `area=00` | `status_machine.json`, `status_pages.json`, `system_scenarios.json` | all areas |
| KB-22 | `useraccess` 3 (in alarm) is "unknown" like an unused area and publishes nothing, so an alarm is never reported | `status_machine.json` | report the alarm |
| KB-27 | A listener that throws aborts the rest of its poll before the new state is saved: the exception is only logged, the same change is announced again on the next poll, and the later sensors of that poll wait until then | `status_listener.test.ts` | - |
| KB-28 | The keep-alive fails only on the login page: any other 2xx body is success, like `arm` | `status_pages.json`, `status.test.ts` | - |
| KB-36 | A table the pattern does not find logs the whole page and the pattern | `status.test.ts` | - |

Not tests, only observations: the config names `HOSTNAME`, `USERNAME` and `PASSWORD` collide with
variables shells and containers set (Docker sets `HOSTNAME` to the container id, so a forgotten value never
triggers the config error there), and the session value is written to the log.

## Panel facts the bridge gets wrong or ignores

Read from the panel's own JavaScript (`commun.js`, `langue.js`, `agaxreq.js` as shipped in
tracstarr/ParadoxAlarmControl) while researching this suite; not verified against your panel. Re-capture
before trusting them for the port.

- `tbl_statuszone`: 0 closed, 1 open, 2 in alarm, 3 closed+trouble, 4 open+trouble, 5 closed+memory, 6 open+memory, 7 bypassed,
  8 closed (drawn like 3), 9 open (drawn like 4). The bridge reads 1, 2, 4, 6 and 9 as open and every other code, unknown ones
  included, as closed, so `tests/data/unarmed.html` (zone 5 = 6, open+memory) publishes ON for that zone.
- `tbl_useraccess`: 0 area unused, 1 disarmed, 2 armed, 3 in alarm, 4 sleep, 5 stay, 6 entry delay, 7 exit delay, 8 ready, 9 not ready, 10 instant.
  The bridge maps 2, 4, 5, 6, 7 and 10 to armed, 1, 8 and 9 to disarmed, and 0, 3 and unknown codes to "unknown", which publishes
  nothing; that *in alarm* (3) stays unknown is KB-22.
  `tests/data/armed.html` was captured during exit delay (7).
- `tbl_zone`: the first number of each pair is an **area bitmask**, not an enabled flag. The bridge keeps every slot with a non-zero
  bitmask, as `paradox/sensor/<slot>` (0-based, the same position in `tbl_statuszone`); armed state and commands still cover area 1
  only (KB-18).
- Commands: `GET /statuslive.html?area=NN&value=X`, NN a two-digit 0-based area (`99` = all), X one of `r` arm, `f` force, `s` stay, `i` instant, `p` sleep, `d` disarm.
- One session at a time, 10 minute lockout after repeated failed logins, the browser keeps alive every 5 s (the bridge: 3 s).
- Firmware: scraping works on IP100 and IP150 below 4.x. IP150 5.x answers `default.html` but returns 404 for `statuslive.html`; a port should detect that. The forward path for those panels is the binary protocol on TCP 10000 (see the PAI project).
- Third-party code for this protocol is GPL or non-commercial licensed in part (maisken, a-lurker); reimplement from behavior, do not copy.

## What the fake panel invents

Responses nobody captured, so tests must not depend on their bodies: the failed-login page (the fake returns
the login page), the response to arm/disarm and keep-alive, what an expired session returns (`requireLogin`
makes the fake answer the login page), the "busy" page when another session is open, the real `useraccess`
transitions while arming. One guess is built in anyway: commands and the keep-alive fail when answered with the login
page, on the assumption that this is what an expired session gets. Capturing these from the real panel is the first
step of the port.
