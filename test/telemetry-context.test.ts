import test from "node:test";
import assert from "node:assert/strict";

import { createCapturePolicy } from "../src/capture-policy.ts";
import {
  currentTelemetryContext,
  formatContextStatus,
  handleLangfuseContextCommand,
  refreshTelemetryContext,
} from "../src/context-command.ts";
import { clearAllSessionStates, getSessionRunState, resetRunState, runWithSession } from "../src/state.ts";
import {
  CONTEXT_ENTRY_TYPE,
  CONTEXT_LIMITS,
  attributeKeyError,
  parseContextRequest,
  parseStoredOperation,
  reconstructContext,
  summarizeContext,
} from "../src/telemetry-context.ts";

const policy = createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "full-debug" });
const SESSION = "01a217ed-da77-70bd-8551-bde5451c8fd4";
const OTHER_SESSION = "01a217ed-da77-70bd-8551-000000000000";

const TASK = {
  taskId: "6f1c2b9e-1111-4c1e-9b7a-0123456789ab",
  taskAttemptId: "8a2d3c4f-2222-4c1e-9b7a-0123456789ab",
  taskType: "review",
  workflowName: "review-pull-request",
  workflowVersion: "sha256:abcdef012345",
  classificationSource: "workflow",
  externalRef: "https://github.com/neo4j/graphql/pull/123",
};

function setJson(operationId: string, attributes: Record<string, unknown> = TASK, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ schemaVersion: 1, operationId, attributes, ...extra });
}

function clearJson(operationId: string) {
  return JSON.stringify({ schemaVersion: 1, operationId });
}

function expectError(op: "set" | "clear", json: string, pattern: RegExp) {
  const result = parseContextRequest(op, json, policy);
  assert.equal(result.ok, false, `expected rejection for ${json}`);
  if (!result.ok) assert.match(result.error, pattern);
}

let entrySeq = 0;
function contextEntry(data: unknown, parentId: string | null = null) {
  return { type: "custom", customType: CONTEXT_ENTRY_TYPE, id: `e${++entrySeq}`, parentId, timestamp: "", data };
}

/** Minimal session tree with a movable leaf, mirroring Pi's SessionManager branch semantics. */
class FakeSession {
  entries: Array<Record<string, any>> = [];
  leafId: string | null = null;
  idle = true;
  pending = false;
  notifications: Array<{ message: string; level?: string }> = [];

  constructor(public sessionId: string) {}

  append(entry: Record<string, any>) {
    const full = { id: `n${++entrySeq}`, parentId: this.leafId, timestamp: "", ...entry };
    this.entries.push(full);
    this.leafId = full.id;
    return full;
  }

  getBranch() {
    const byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    const path = [];
    let cursor = this.leafId ? byId.get(this.leafId) : undefined;
    while (cursor) {
      path.unshift(cursor);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return path;
  }

  ctx() {
    return {
      hasUI: true,
      ui: { notify: (message: string, level?: string) => this.notifications.push({ message, level }) },
      isIdle: () => this.idle,
      hasPendingMessages: () => this.pending,
      sessionManager: { getBranch: () => this.getBranch(), getSessionId: () => this.sessionId },
    };
  }

  run(args: string) {
    return runWithSession(this.sessionId, () =>
      handleLangfuseContextCommand(args, this.ctx(), {
        sessionId: this.sessionId,
        policy,
        appendEntry: (customType, data) => this.append({ type: "custom", customType, data }),
      }));
  }

  contextEntries() {
    return this.entries.filter((entry) => entry.customType === CONTEXT_ENTRY_TYPE);
  }
}

test("accepts the documented contract and keeps flat string values", () => {
  const result = parseContextRequest("set", setJson("op-00000001"), policy);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual({ ...result.value.attributes }, TASK);
    assert.equal(Object.isFrozen(result.value.attributes), true);
  }
});

test("rejects malformed requests, unsupported versions and unexpected fields", () => {
  expectError("set", "{not json", /not valid JSON/);
  expectError("set", "[]", /JSON object/);
  expectError("set", "null", /JSON object/);
  expectError("set", JSON.stringify({ schemaVersion: 2, operationId: "op-00000001", attributes: TASK }), /schemaVersion/);
  expectError("set", JSON.stringify({ operationId: "op-00000001", attributes: TASK }), /schemaVersion/);
  expectError("set", JSON.stringify({ schemaVersion: "1", operationId: "op-00000001", attributes: TASK }), /schemaVersion/);
  expectError("set", setJson("short"), /operationId/);
  expectError("set", setJson("op 00000001"), /operationId/);
  expectError("set", setJson("op-00000001", TASK, { extra: true }), /unexpected request field/);
  expectError("clear", JSON.stringify({ schemaVersion: 1, operationId: "op-00000001", attributes: TASK }), /unexpected/);
  expectError("set", setJson("op-00000001", {}), /must not be empty/);
  expectError("set", JSON.stringify({ schemaVersion: 1, operationId: "op-00000001", attributes: ["a"] }), /JSON object/);
  expectError("set", "x".repeat(CONTEXT_LIMITS.maxRequestBytes + 1), /too large/);
});

test("rejects non-string, empty, oversized and control-character values", () => {
  expectError("set", setJson("op-00000001", { taskType: 1 }), /must be a string/);
  expectError("set", setJson("op-00000001", { taskType: { nested: "x" } }), /must be a string/);
  expectError("set", setJson("op-00000001", { taskType: ["x"] }), /must be a string/);
  expectError("set", setJson("op-00000001", { taskType: "" }), /1-200/);
  expectError("set", setJson("op-00000001", { taskType: "x".repeat(201) }), /1-200/);
  expectError("set", setJson("op-00000001", { taskType: "a\nb" }), /control characters/);
  const tooMany = Object.fromEntries(Array.from({ length: CONTEXT_LIMITS.maxKeys + 1 }, (_, i) => [`k${i}`, "v"]));
  expectError("set", setJson("op-00000001", tooMany), /too many attributes/);
  const large = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`key${i}`, "v".repeat(199)]));
  expectError("set", setJson("op-00000001", large), /exceed 4096 bytes/);
});

test("rejects reserved, prototype-sensitive and credential-like keys", () => {
  for (const key of [
    "sessionId", "sessionKind", "parentSessionId", "model", "provider", "modelId", "providerName",
    "userId", "cwd", "attemptIndex", "piScope", "piContextRevision", "langfuseTraceId", "traceName",
    "source_type", "git_dirty", "vcs", "constructor", "prototype", "toString", "hasOwnProperty",
  ]) {
    assert.match(attributeKeyError(key) ?? "", /reserved/, key);
  }
  for (const key of ["__proto__", "1abc", "a-b", "a.b", "", "x".repeat(65), "ü"]) {
    assert.match(attributeKeyError(key) ?? "", /invalid attribute key/, JSON.stringify(key));
  }
  for (const key of ["apiKey", "api_key", "githubToken", "secret", "password", "auth", "basicAuth", "authorization", "cookie"]) {
    assert.match(attributeKeyError(key) ?? "", /credential/, key);
  }
  for (const key of ["author", "taskId", "taskAttemptId", "workflowName", "externalRef", "team"]) {
    assert.equal(attributeKeyError(key), undefined, key);
  }
  // A literal __proto__ key from JSON.parse is an own property, not a prototype write.
  expectError("set", '{"schemaVersion":1,"operationId":"op-00000001","attributes":{"__proto__":"x"}}', /invalid attribute key/);
});

test("redacts values like other telemetry and refuses detected secrets", () => {
  expectError("set", setJson("op-00000001", { note1: "Bearer abcdefghijklmnopqrstuvwxyz" }), /secret/);
  expectError("set", setJson("op-00000001", { ref: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }), /secret/);
  expectError("set", setJson("op-00000001", { ref: "password=hunter2" }), /secret/);

  const hashed = parseContextRequest("set", setJson("op-00000001", { checkout: "/home/alice/repo" }), policy);
  assert.equal(hashed.ok, true);
  if (hashed.ok) assert.match(hashed.value.attributes!.checkout, /^\[PATH_HASH:[0-9a-f]{12}\]$/);

  const pathPolicy = createCapturePolicy({ LANGFUSE_CAPTURE_PATHS: "true" });
  const verbatim = parseContextRequest("set", setJson("op-00000001", { checkout: "/home/alice/repo" }), pathPolicy);
  assert.equal(verbatim.ok, true);
  if (verbatim.ok) assert.equal(verbatim.value.attributes!.checkout, "/home/alice/repo");
});

test("validates known attribute semantics", () => {
  expectError("set", setJson("op-00000001", { taskId: "t1", classificationSource: "model" }), /classificationSource/);
  expectError("set", setJson("op-00000001", { taskAttemptId: "a1" }), /requires taskId/);
});

test("set replaces the whole context, clear writes a tombstone, status reports both", () => {
  clearAllSessionStates();
  const session = new FakeSession(SESSION);

  assert.equal(session.run(`set ${setJson("op-00000001")}`).status, "accepted");
  assert.equal(session.run(`set ${setJson("op-00000002", { taskId: "task-b", taskType: "advisory" })}`).status, "accepted");
  let context = runWithSession(SESSION, currentTelemetryContext);
  assert.deepEqual({ ...context.attributes }, { taskId: "task-b", taskType: "advisory" });
  assert.equal(context.revision, 2);

  assert.equal(session.run(`clear ${clearJson("op-00000003")}`).status, "accepted");
  context = runWithSession(SESSION, currentTelemetryContext);
  assert.equal(context.attributes, undefined);
  assert.equal(context.lastOperation, "clear");
  assert.equal(summarizeContext(context), "cleared");

  const entries = session.contextEntries();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[2].data, { schemaVersion: 1, op: "clear", operationId: "op-00000003", sessionId: SESSION });
  assert.equal(entries[0].data.sessionId, SESSION);

  assert.equal(session.run("status").status, "status");
  assert.match(session.notifications.at(-1)!.message, /revision 3\): cleared/);
});

test("operations are idempotent by operation ID; reuse with another payload is rejected", () => {
  clearAllSessionStates();
  const session = new FakeSession(SESSION);
  assert.equal(session.run(`set ${setJson("op-00000001")}`).status, "accepted");
  const reordered = Object.fromEntries(Object.entries(TASK).reverse());
  assert.equal(session.run(`set ${setJson("op-00000001", reordered)}`).status, "duplicate");
  assert.equal(session.contextEntries().length, 1);

  const conflicting = session.run(`set ${setJson("op-00000001", { taskId: "other" })}`);
  assert.equal(conflicting.status, "rejected");
  assert.match(conflicting.error!, /already used/);
  const asClear = session.run(`clear ${clearJson("op-00000001")}`);
  assert.equal(asClear.status, "rejected");
  assert.equal(session.contextEntries().length, 1);
  assert.equal(runWithSession(SESSION, currentTelemetryContext).attributes?.taskId, TASK.taskId);
});

test("invalid requests and busy sessions leave accepted context unchanged", () => {
  clearAllSessionStates();
  const session = new FakeSession(SESSION);
  session.run(`set ${setJson("op-00000001")}`);

  for (const args of [
    `set ${setJson("op-00000002", { sessionId: "spoof" })}`,
    `set ${setJson("op-00000002", { model: "relabelled" })}`,
    "set {broken",
    "set",
    "frobnicate",
    "status extra",
  ]) {
    assert.equal(session.run(args).status, "rejected", args);
  }

  session.idle = false;
  const busy = session.run(`set ${setJson("op-00000003", { taskId: "x" })}`);
  assert.match(busy.error!, /busy/);
  assert.equal(session.run(`clear ${clearJson("op-00000004")}`).status, "rejected");

  session.idle = true;
  session.pending = true;
  assert.match(session.run(`set ${setJson("op-00000005", { taskId: "x" })}`).error!, /queued/);

  assert.equal(session.contextEntries().length, 1);
  assert.equal(runWithSession(SESSION, currentTelemetryContext).attributes?.taskId, TASK.taskId);
  assert.ok(session.notifications.filter((n) => n.level === "error").length >= 9);
});

test("a host without idle reporting or session identity cannot mutate context", () => {
  clearAllSessionStates();
  const appended: unknown[] = [];
  const base = { sessionManager: { getBranch: () => [] }, isIdle: () => true, hasPendingMessages: () => false };
  const deps = { sessionId: SESSION, policy, appendEntry: (_type: string, data: unknown) => appended.push(data) };
  assert.equal(handleLangfuseContextCommand(`set ${setJson("op-00000001")}`, { ...base, isIdle: undefined }, deps).status, "rejected");
  assert.equal(handleLangfuseContextCommand(`set ${setJson("op-00000001")}`, base, { ...deps, sessionId: undefined }).status, "rejected");
  assert.equal(handleLangfuseContextCommand(`set ${setJson("op-00000001")}`, { ...base, sessionManager: {} }, deps).status, "rejected");
  assert.equal(appended.length, 0);
});

test("reconstruction follows the active branch only, so tree navigation restores earlier context", () => {
  clearAllSessionStates();
  const session = new FakeSession(SESSION);
  session.append({ type: "message", message: { role: "user" } });
  session.run(`set ${setJson("op-00000001", { taskId: "task-a" })}`);
  const forkPoint = session.leafId;
  session.append({ type: "message", message: { role: "user" } });
  session.run(`set ${setJson("op-00000002", { taskId: "task-b" })}`);
  assert.equal(runWithSession(SESSION, currentTelemetryContext).attributes?.taskId, "task-b");

  // /tree back to the fork point: the abandoned branch's task-b no longer applies.
  session.leafId = forkPoint;
  const restored = runWithSession(SESSION, () => refreshTelemetryContext(session.ctx().sessionManager, SESSION, policy));
  assert.equal(restored.attributes?.taskId, "task-a");
  assert.equal(restored.revision, 1);
  // op-00000002 lives only on the abandoned branch, so it may be applied here afresh.
  assert.equal(session.run(`set ${setJson("op-00000002", { taskId: "task-c" })}`).status, "accepted");
  assert.equal(runWithSession(SESSION, currentTelemetryContext).attributes?.taskId, "task-c");
});

test("forked or cloned sessions ignore inherited context; clear tombstones are not resurrected", () => {
  const branch = [
    contextEntry({ schemaVersion: 1, op: "set", operationId: "op-00000001", sessionId: OTHER_SESSION, attributes: { taskId: "parent" } }),
  ];
  const inherited = reconstructContext(branch, SESSION, policy);
  assert.equal(inherited.attributes, undefined);
  assert.equal(inherited.inheritedEntries, 1);
  assert.equal(reconstructContext(branch, OTHER_SESSION, policy).attributes?.taskId, "parent");

  const withTombstone = [
    contextEntry({ schemaVersion: 1, op: "set", operationId: "op-00000001", sessionId: SESSION, attributes: { taskId: "a" } }),
    contextEntry({ schemaVersion: 1, op: "clear", operationId: "op-00000002", sessionId: SESSION }),
  ];
  assert.equal(reconstructContext(withTombstone, SESSION, policy).attributes, undefined);
  assert.equal(reconstructContext(withTombstone, undefined, policy).attributes, undefined);
});

test("malformed, unknown-version and tampered historical entries are skipped safely", () => {
  const branch = [
    contextEntry({ schemaVersion: 1, op: "set", operationId: "op-00000001", sessionId: SESSION, attributes: { taskId: "good" } }),
    contextEntry({ schemaVersion: 2, op: "set", operationId: "op-00000002", sessionId: SESSION, attributes: { taskId: "future" } }),
    contextEntry({ schemaVersion: 1, op: "set", operationId: "op-00000003", sessionId: SESSION, attributes: { model: "spoof" } }),
    contextEntry({ schemaVersion: 1, op: "merge", operationId: "op-00000004", sessionId: SESSION }),
    contextEntry({ schemaVersion: 1, op: "clear", operationId: "op-00000005", sessionId: SESSION, attributes: { taskId: "x" } }),
    contextEntry("garbage"),
    contextEntry(null),
    { type: "custom", customType: "someone-else", data: { schemaVersion: 1, op: "clear", operationId: "op-00000006", sessionId: SESSION } },
    null,
  ];
  const context = reconstructContext(branch, SESSION, policy);
  assert.equal(context.attributes?.taskId, "good");
  assert.equal(context.revision, 1);
  assert.equal(context.ignoredEntries, 6);
  assert.match(formatContextStatus(context), /Ignored 6 malformed/);
  assert.equal(parseStoredOperation({ schemaVersion: 1, op: "set", operationId: "op-00000001", sessionId: "" }, policy), undefined);
});

test("context state is per session and survives per-run resets", () => {
  clearAllSessionStates();
  const a = new FakeSession(SESSION);
  const b = new FakeSession(OTHER_SESSION);
  a.run(`set ${setJson("op-00000001", { taskId: "task-a" })}`);
  b.run(`set ${setJson("op-00000001", { taskId: "task-b" })}`);
  assert.equal(runWithSession(SESSION, currentTelemetryContext).attributes?.taskId, "task-a");
  assert.equal(runWithSession(OTHER_SESSION, currentTelemetryContext).attributes?.taskId, "task-b");

  runWithSession(SESSION, () => resetRunState());
  assert.equal(runWithSession(SESSION, () => getSessionRunState().telemetryContext.attributes?.taskId), "task-a");
  b.run(`clear ${clearJson("op-00000002")}`);
  assert.equal(runWithSession(SESSION, currentTelemetryContext).attributes?.taskId, "task-a");
});

test("status summaries shorten IDs and long values", () => {
  const context = reconstructContext([
    contextEntry({ schemaVersion: 1, op: "set", operationId: "op-00000001", sessionId: SESSION, attributes: TASK }),
  ], SESSION, policy);
  const summary = summarizeContext(context);
  assert.match(summary, /taskId=6f1c2b9e…/);
  assert.doesNotMatch(summary, /0123456789ab/);
  assert.match(summary, /taskType=review/);
});
