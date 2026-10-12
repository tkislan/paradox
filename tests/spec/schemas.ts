import { z } from 'zod';

/*
 * The format of every spec/*.json file. Objects are strict, so an unknown key or a wrong type in a spec file fails its
 * load instead of leaving a test that silently checks less. The files under known_bugs/ use the same row formats.
 */

const row = { name: z.string(), note: z.string().optional(), known_bug: z.string().optional() };
const comment = { _comment: z.string() };

/** [enabled, name] of a panel zone. */
const Zone = z.tuple([z.number(), z.string()]);

/** Text given inline, or as {file} relative to tests/. */
export const Text = z.union([z.string(), z.strictObject({ file: z.string() })]);

// crypto.json

const Vector = z.strictObject({ ...row, input: z.string(), expected: z.string() });

export const CryptoSpec = z.strictObject({
  ...comment,
  hex_md5: z.array(Vector),
  keeplowbyte: z.array(Vector),
  rc4: z.array(z.strictObject({
    ...row,
    key: z.string(),
    text: z.string(),
    expected: z.string(),
    not_classic_rc4: z.string().optional(),
    source: z.string().optional(),
    js_only: z.boolean().optional(),
  })),
  credentials: z.array(z.strictObject({
    ...row,
    session: z.string(),
    username: z.string(),
    password: z.string(),
    u: z.string(),
    p: z.string(),
    source: z.string().optional(),
  })),
});

// util.json

const TupleList = z.array(z.union([z.number(), z.string()]));
const Returned = z.union([z.string(), z.number(), z.null()]);

const util = {
  deepArrayEqual: z.array(z.strictObject({ ...row, a: z.array(z.json()).nullable(), b: z.array(z.json()).nullable(), expected: z.boolean() })),
  getJsValue: z.array(z.strictObject({ ...row, content: Text, pattern: z.string(), expected: z.json(), js_only: z.boolean().optional() })),
  iterateTuples: z.array(z.strictObject({ ...row, list: TupleList, expected: z.array(Zone) })),
};

export const UtilSpec = z.strictObject({
  ...comment,
  ...util,
  getJsValue_errors: z.array(z.strictObject({ ...row, content: Text, pattern: z.string(), error: z.string() })),
  iterateTuples_errors: z.array(z.strictObject({ ...row, list: TupleList, error: z.string() })),
  retry: z.array(z.strictObject({
    ...row,
    max_retries: z.number(),
    wait_ms: z.number(),
    attempts: z.array(z.union([z.strictObject({ returns: Returned }), z.strictObject({ throws: z.string() })])),
    expected: z.strictObject({ calls: z.number(), returns: Returned.optional(), throws: z.string().optional() }),
  })),
  objectEntries: z.array(z.strictObject({ ...row, object: z.record(z.string(), z.json()), expected: z.array(z.tuple([z.string(), z.json()])) })),
});

export const KnownBugUtilSpec = z.strictObject({ ...comment, ...util });

// status_pages.json

/** A parsed status table: its values, or how many empty slots `new Array(n)` made. */
const Slots = z.union([z.array(z.number()), z.strictObject({ empty_slots: z.number() })]);

export const StatusPagesSpec = z.strictObject({
  ...comment,
  get_status: z.array(z.strictObject({
    ...row,
    page: Text,
    expected: z.union([
      z.strictObject({ statuszone: Slots, useraccess: Slots, alarms: z.array(z.number()) }),
      z.strictObject({ error: z.string() }),
    ]),
  })),
  requests: z.array(z.strictObject({
    operation: z.string(),
    request: z.string(),
    absent_headers: z.array(z.string()),
    note: z.string().optional(),
    known_bug: z.string().optional(),
  })),
  body_ignoring_responses: z.array(z.strictObject({
    ...row,
    response: z.strictObject({ status: z.number(), body: Text }),
    expected: z.union([z.strictObject({ result: z.null() }), z.strictObject({ error: z.string() })]),
  })),
});

// login_cases.json

/** How the fake panel answers one request. */
export const ResponseRule = z.strictObject({
  file: z.string().optional(),
  body: z.string().optional(),
  zones: z.array(Zone).optional(),
  zones_by_slot: z.record(z.string(), Zone).optional(),
  destroy: z.boolean().optional(),
  hang: z.boolean().optional(),
  status: z.number().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  times: z.number().optional(),
});
export type ResponseRule = z.infer<typeof ResponseRule>;

/** Per request path: one response, or several used in order. */
const Responses = z.record(z.string(), z.union([ResponseRule, z.array(ResponseRule)]));

const LoginOutcome = z.strictObject({
  zoneTuples: z.array(Zone).optional(),
  error: z.string().optional(),
  request_counts: z.record(z.string(), z.number()).optional(),
  warnings: z.array(z.string()).optional(),
  default_query: z.string().optional(),
});

const LoginRow = z.strictObject({ ...row, panel: Responses, expected: LoginOutcome });

export const LoginCasesSpec = z.strictObject({
  ...comment,
  login: z.array(LoginRow),
  logout: z.array(z.strictObject({ ...row, panel: Responses, expected: z.strictObject({ error: z.string().optional() }) })),
  request_headers: z.array(z.strictObject({
    ...row,
    path: z.string(),
    headers: z.record(z.string(), z.string()),
    complete: z.boolean().optional(),
    headers_starting_with: z.record(z.string(), z.string()).optional(),
    absent: z.array(z.string()).optional(),
  })),
});

export const KnownBugLoginCasesSpec = z.strictObject({
  ...comment,
  login: z.array(LoginRow),
  index_retry: z.array(LoginRow),
  hangs: z.array(z.strictObject({ ...row, hang: z.string(), expected: z.strictObject({ request_counts: z.record(z.string(), z.number()) }) })),
});

// status_machine.json

const Fail = z.strictObject({
  status: z.number().optional(),
  body: z.string().optional(),
  connection: z.enum(['refused', 'reset']).optional(),
  page: Text.optional(),
});

const Poll = z.strictObject({
  statuszone: z.array(z.number()).optional(),
  useraccess: z.array(z.number()).optional(),
  page: Text.optional(),
  fail: Fail.optional(),
});

const ListenerEvent = z.union([
  z.tuple([z.literal('armedChanged'), z.boolean().nullable()]),
  z.tuple([z.literal('sensorChanged'), z.string(), z.boolean()]),
  z.tuple([z.literal('error')]),
]);

const Timeline = z.array(z.strictObject({ ...row, zones: z.array(Zone), polls: z.array(Poll), expected_events: z.array(ListenerEvent) }));

export const StatusMachineSpec = z.strictObject({
  ...comment,
  first_poll: Timeline,
  armed_codes: Timeline,
  sensor_codes: Timeline,
  transitions: Timeline,
  failures: Timeline,
  status_poll_cadence: z.array(z.strictObject({ ...row, advance_ms: z.array(z.number()), expected_requests: z.array(z.number()) })),
});

export const KnownBugStatusMachineSpec = z.strictObject({
  ...comment,
  first_poll: Timeline,
  armed_codes: Timeline,
  sensor_codes: Timeline,
  zone_indexing: Timeline,
  failures: Timeline,
});

// system_scenarios.json

const faultTarget = { path: z.string(), times: z.number().optional() };

export const PanelFault = z.discriminatedUnion('kind', [
  z.strictObject({ ...faultTarget, kind: z.enum(['http_500', 'reset', 'hang', 'login_page', 'garbage', 'wrong_title']) }),
  z.strictObject({ ...faultTarget, kind: z.literal('page'), page: Text }),
]);
export type PanelFault = z.infer<typeof PanelFault>;

const PanelState = {
  statuszone: z.array(z.number()).optional(),
  useraccess: z.array(z.number()).optional(),
};

const Expect = z.strictObject({
  mqtt_published: z.array(z.strictObject({ topic: z.string(), payload: z.string() })).optional(),
  panel_requests: z.array(z.string()).optional(),
  panel_requests_any_order: z.array(z.string()).optional(),
  panel_request_counts: z.record(z.string(), z.number()).optional(),
  process_exit: z.array(z.number()).optional(),
  logged_error: z.boolean().optional(),
  broker_retained: z.record(z.string(), z.string().nullable()).optional(),
});
export type Expect = z.infer<typeof Expect>;

const Step = z.strictObject({
  panel_status: z.strictObject({ ...PanelState, alarms: z.array(z.string()).optional() }).optional(),
  panel_fault: PanelFault.optional(),
  panel_expire_session: z.boolean().optional(),
  panel_down: z.boolean().optional(),
  mqtt_command: z.union([z.enum(['arm', 'disarm']), z.strictObject({ topic: z.string(), payload: z.string() })]).optional(),
  advance_ms: z.number().optional(),
  expect: Expect.optional(),
});
export type Step = z.infer<typeof Step>;

export const ScenarioPanel = z.strictObject({
  ...PanelState,
  zones: z.array(Zone).optional(),
  accept_login: z.boolean().optional(),
  down: z.boolean().optional(),
  faults: z.array(PanelFault).optional(),
});
export type ScenarioPanel = z.infer<typeof ScenarioPanel>;

export const ScenarioBroker = z.strictObject({ retained: z.record(z.string(), z.string()).optional() });
export type ScenarioBroker = z.infer<typeof ScenarioBroker>;

const Scenario = z.strictObject({
  ...row,
  panel: ScenarioPanel.optional(),
  broker: ScenarioBroker.optional(),
  start: z.strictObject({ ready: z.boolean().optional(), expect: Expect.optional() }).optional(),
  steps: z.array(Step).optional(),
});
export type Scenario = z.infer<typeof Scenario>;

const scenarioGroups = {
  startup: z.array(Scenario),
  keep_alive: z.array(Scenario),
  armed: z.array(Scenario),
  sensors: z.array(Scenario),
  mqtt_commands: z.array(Scenario),
  failures: z.array(Scenario),
};

export const SystemScenariosSpec = z.strictObject({
  ...comment,
  login: z.strictObject({ session: z.string(), username: z.string(), password: z.string(), u: z.string(), p: z.string() }),
  ...scenarioGroups,
});

export const KnownBugSystemScenariosSpec = z.strictObject({ ...comment, ...scenarioGroups });

/** Any spec file, for checks that look at every row whatever its table. */
export const AnySpec = z.record(z.string(), z.json());
