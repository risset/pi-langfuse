/**
 * Caller-supplied telemetry context: schema, validation and branch-aware
 * reconstruction.
 *
 * A client (for example an editor driving Pi over RPC) attaches flat string
 * attributes such as a task ID to every later trace of the current session by
 * running `/langfuse-context set <JSON>`. Accepted operations are persisted as
 * non-model `custom` session entries, so the context follows the session tree:
 * it survives restart/resume, is rebuilt on `/tree` navigation, and does not
 * enter provider input.
 *
 * This module is pure apart from the redaction helpers it calls; the command
 * handler and lifecycle wiring live in `context-command.ts` and `index.ts`.
 */

import { redactOptionsFor, type CapturePolicy } from "./capture-policy.js";
import { REDACTED, redactString } from "./redaction.js";

export const CONTEXT_COMMAND = "langfuse-context";
export const CONTEXT_ENTRY_TYPE = "pi-langfuse.context";
export const CONTEXT_SCHEMA_VERSION = 1;

export const CONTEXT_LIMITS = Object.freeze({
  maxKeys: 24,
  maxKeyLength: 64,
  /** Langfuse drops propagated trace metadata values above 200 characters. */
  maxValueLength: 200,
  maxTotalBytes: 4096,
  /** Upper bound for the raw command argument, checked before JSON parsing. */
  maxRequestBytes: 16 * 1024,
});

export type ContextAttributes = Readonly<Record<string, string>>;
export type ContextOperationKind = "set" | "clear";

/** Persisted `custom` entry data. Always written with the current schema version. */
export interface ContextOperation {
  readonly schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  readonly op: ContextOperationKind;
  readonly operationId: string;
  /** Pi session that accepted the operation; entries copied into forks/clones do not match. */
  readonly sessionId: string;
  readonly attributes?: ContextAttributes;
}

export interface ContextState {
  /** Active custom attributes, or undefined when no context is set (never set or cleared). */
  readonly attributes?: ContextAttributes;
  /** Number of accepted operations on the active branch for this session. */
  readonly revision: number;
  readonly lastOperationId?: string;
  readonly lastOperation?: ContextOperationKind;
  /** Operations on the active branch, keyed by operation ID (for idempotency). */
  readonly operations: ReadonlyMap<string, ContextOperation>;
  /** Context entries on the branch written by another session (fork/clone ancestry). */
  readonly inheritedEntries: number;
  /** Malformed or unsupported context entries skipped during reconstruction. */
  readonly ignoredEntries: number;
}

/**
 * Keys written by this integration (trace, root, generation, tool and source
 * metadata) plus a few object-prototype names. Callers may not shadow or
 * relabel them, in particular model/provider/session identity.
 */
const RESERVED_KEYS = new Set([
  "aborted", "action", "activeToolCount", "actualModel", "actualProvider", "agentAttemptCount",
  "attemptCount", "attemptIndex", "cacheHitRatio", "cachePreservationExpected", "cacheReadTokens",
  "cacheWriteTokens", "cancelled", "changeKind", "checkpointSectionNames", "checkpointToolCount",
  "checkpointToolNames", "compactionEntryId", "completed", "constructor", "contextPercent",
  "contextTokens", "contextWindow", "continuationProbability", "cwd", "environment", "errorMessage",
  "finishReason", "firstKeptEntryId", "fromExtension", "git_detached", "git_dirty", "hasOwnProperty",
  "id", "idle", "inputBytes", "isPrototypeOf", "kind", "level", "metadata_source", "missCostEstimate",
  "model", "name", "note", "observationId", "parentObservationId", "parentSessionId",
  "parentToolCallId", "promptChars", "promptStateHash", "propertyIsEnumerable", "prototype", "provider",
  "providerMetadata", "reason", "release", "requestId", "requestKey", "sectionsChanged",
  "sectionsRemoved", "selectedModel", "selectedProvider", "session_had_errors", "source",
  "sourceEvent", "source_type", "stateSequence", "status", "statusMessage", "stopReason",
  "systemPrompt", "systemStateChangeCount", "systemStateSequence", "tags", "toLocaleString",
  "toString", "tokensBefore", "toolName", "toolStateHash", "tool_call_count", "tool_success_rate",
  "totalTools", "total_tool_errors", "traceId", "traceName", "transcriptEntryIds", "turn_count",
  "type", "uncachedInputTokens", "usageEntryId", "usageSource", "userId", "valueOf", "version",
  "warmCostEstimate", "willRetry",
]);

/** Integration-owned prefixes: session/model/provider identity, Pi/Langfuse internals, VCS source. */
const RESERVED_PREFIX_RE = /^(?:session|model|provider|langfuse|otel|pi[A-Z0-9_]|vcs|git_|source_|trace|observation)/i;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
/** Credential-like names are refused outright rather than masked. */
const SENSITIVE_KEY_RE = /secret|token|passw|api_?key|private_?key|credential|authori[sz]|cookie|bearer/i;
/** "auth" as its own word or camelCase part, without matching "author". */
const AUTH_KEY_RE = /(?:^|_)[Aa]uth(?:$|_|[A-Z0-9])|[a-z0-9]Auth(?:$|_|[A-Z0-9])|AUTH/;
const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const CLASSIFICATION_SOURCES = new Set(["workflow", "user"]);

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function fail<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Why `key` is not an acceptable custom attribute name, or undefined when it is. */
export function attributeKeyError(key: string): string | undefined {
  if (key.length === 0 || key.length > CONTEXT_LIMITS.maxKeyLength || !KEY_RE.test(key)) {
    return `invalid attribute key ${JSON.stringify(key.slice(0, 80))}`;
  }
  if (RESERVED_KEYS.has(key) || RESERVED_PREFIX_RE.test(key)) {
    return `attribute key ${JSON.stringify(key)} is reserved by the integration`;
  }
  if (SENSITIVE_KEY_RE.test(key) || AUTH_KEY_RE.test(key)) {
    return `attribute key ${JSON.stringify(key)} looks like a credential`;
  }
  return undefined;
}

/**
 * Validates and redacts custom attributes. Values are passed through the same
 * redaction as other telemetry (paths hashed unless the capture policy allows
 * them); a value in which a secret is detected is rejected, never stored.
 */
export function validateAttributes(
  raw: unknown,
  policy: CapturePolicy,
): ValidationResult<ContextAttributes> {
  if (!isPlainObject(raw)) {
    return fail("attributes must be a JSON object");
  }
  const keys = Object.keys(raw);
  if (keys.length === 0) {
    return fail("attributes must not be empty; use clear to remove context");
  }
  if (keys.length > CONTEXT_LIMITS.maxKeys) {
    return fail(`too many attributes (${keys.length} > ${CONTEXT_LIMITS.maxKeys})`);
  }

  const output: Record<string, string> = {};
  for (const key of keys) {
    const keyError = attributeKeyError(key);
    if (keyError) {
      return fail(keyError);
    }
    const value = raw[key];
    if (typeof value !== "string") {
      return fail(`attribute ${key} must be a string`);
    }
    if (value.length === 0 || value.length > CONTEXT_LIMITS.maxValueLength) {
      return fail(`attribute ${key} must be 1-${CONTEXT_LIMITS.maxValueLength} characters`);
    }
    if (CONTROL_CHAR_RE.test(value)) {
      return fail(`attribute ${key} contains control characters`);
    }
    const redacted = redactString(value, {
      ...redactOptionsFor(policy),
      maxStringLength: CONTEXT_LIMITS.maxValueLength,
    });
    if (redacted.includes(REDACTED)) {
      return fail(`attribute ${key} looks like it contains a secret`);
    }
    if (redacted.length > CONTEXT_LIMITS.maxValueLength) {
      return fail(`attribute ${key} is too long after redaction`);
    }
    output[key] = redacted;
  }

  if (output.classificationSource !== undefined && !CLASSIFICATION_SOURCES.has(output.classificationSource)) {
    return fail("classificationSource must be \"workflow\" or \"user\"");
  }
  if (output.taskAttemptId !== undefined && output.taskId === undefined) {
    return fail("taskAttemptId requires taskId");
  }
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > CONTEXT_LIMITS.maxTotalBytes) {
    return fail(`attributes exceed ${CONTEXT_LIMITS.maxTotalBytes} bytes`);
  }
  return { ok: true, value: Object.freeze(output) };
}

export interface ContextRequest {
  readonly op: ContextOperationKind;
  readonly operationId: string;
  readonly attributes?: ContextAttributes;
}

/** Parses and validates the JSON argument of `/langfuse-context set|clear`. */
export function parseContextRequest(
  op: ContextOperationKind,
  json: string,
  policy: CapturePolicy,
): ValidationResult<ContextRequest> {
  if (Buffer.byteLength(json, "utf8") > CONTEXT_LIMITS.maxRequestBytes) {
    return fail("request is too large");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return fail("request is not valid JSON");
  }
  if (!isPlainObject(raw)) {
    return fail("request must be a JSON object");
  }
  const allowed = op === "set" ? ["schemaVersion", "operationId", "attributes"] : ["schemaVersion", "operationId"];
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    return fail(`unexpected request field ${JSON.stringify(unknown[0].slice(0, 80))}`);
  }
  if (raw.schemaVersion !== CONTEXT_SCHEMA_VERSION) {
    return fail(`unsupported schemaVersion (expected ${CONTEXT_SCHEMA_VERSION})`);
  }
  if (typeof raw.operationId !== "string" || !OPERATION_ID_RE.test(raw.operationId)) {
    return fail("operationId must be 8-128 characters of [A-Za-z0-9._:-]");
  }
  if (op === "clear") {
    return { ok: true, value: { op, operationId: raw.operationId } };
  }
  const attributes = validateAttributes(raw.attributes, policy);
  if (!attributes.ok) {
    return attributes;
  }
  return { ok: true, value: { op, operationId: raw.operationId, attributes: attributes.value } };
}

/** Builds the persisted entry data for an accepted request. */
export function toOperation(request: ContextRequest, sessionId: string): ContextOperation {
  return Object.freeze({
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    op: request.op,
    operationId: request.operationId,
    sessionId,
    ...(request.op === "set" && request.attributes ? { attributes: request.attributes } : {}),
  });
}

/** Parses a persisted entry, re-validating it; returns undefined for malformed or unknown data. */
export function parseStoredOperation(data: unknown, policy: CapturePolicy): ContextOperation | undefined {
  if (!isPlainObject(data) || data.schemaVersion !== CONTEXT_SCHEMA_VERSION) {
    return undefined;
  }
  if (data.op !== "set" && data.op !== "clear") {
    return undefined;
  }
  if (typeof data.operationId !== "string" || !OPERATION_ID_RE.test(data.operationId)) {
    return undefined;
  }
  if (typeof data.sessionId !== "string" || data.sessionId.length === 0) {
    return undefined;
  }
  if (data.op === "clear") {
    return data.attributes === undefined
      ? toOperation({ op: "clear", operationId: data.operationId }, data.sessionId)
      : undefined;
  }
  const attributes = validateAttributes(data.attributes, policy);
  if (!attributes.ok) {
    return undefined;
  }
  return toOperation({ op: "set", operationId: data.operationId, attributes: attributes.value }, data.sessionId);
}

interface BranchEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

/**
 * Rebuilds the context from the active branch (root to leaf). Abandoned
 * branches are never consulted. Entries accepted by a different session, i.e.
 * copied into a fork or clone, are ignored: a derived session starts clear
 * unless its own client explicitly sets context again.
 */
export function reconstructContext(
  branch: readonly unknown[],
  sessionId: string | undefined,
  policy: CapturePolicy,
): ContextState {
  let attributes: ContextAttributes | undefined;
  let revision = 0;
  let lastOperationId: string | undefined;
  let lastOperation: ContextOperationKind | undefined;
  let inheritedEntries = 0;
  let ignoredEntries = 0;
  const operations = new Map<string, ContextOperation>();

  for (const candidate of branch) {
    const entry = candidate as BranchEntryLike | null;
    if (!entry || entry.type !== "custom" || entry.customType !== CONTEXT_ENTRY_TYPE) {
      continue;
    }
    const operation = parseStoredOperation(entry.data, policy);
    if (!operation) {
      ignoredEntries++;
      continue;
    }
    if (!sessionId || operation.sessionId !== sessionId) {
      inheritedEntries++;
      continue;
    }
    attributes = operation.op === "set" ? operation.attributes : undefined;
    revision++;
    lastOperationId = operation.operationId;
    lastOperation = operation.op;
    operations.set(operation.operationId, operation);
  }

  return Object.freeze({
    attributes,
    revision,
    lastOperationId,
    lastOperation,
    operations,
    inheritedEntries,
    ignoredEntries,
  });
}

/** Whether a repeated operation ID carries the same request (an idempotent retry). */
export function sameOperation(existing: ContextOperation, request: ContextRequest): boolean {
  if (existing.op !== request.op) {
    return false;
  }
  return stableJson(existing.attributes ?? null) === stableJson(request.attributes ?? null);
}

function stableJson(value: Readonly<Record<string, string>> | null): string {
  if (!value) {
    return "null";
  }
  return JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));
}

/** Short, non-sensitive description for status output and notifications. */
export function summarizeContext(context: ContextState): string {
  if (!context.attributes) {
    return context.revision > 0 ? "cleared" : "none";
  }
  const shown: string[] = [];
  for (const [key, value] of Object.entries(context.attributes)) {
    const display = /Id$/.test(key) && value.length > 12 ? `${value.slice(0, 8)}…` : value.length > 40 ? `${value.slice(0, 37)}…` : value;
    shown.push(`${key}=${display}`);
  }
  return shown.join(" ");
}
