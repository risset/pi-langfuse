import type { CapturePolicy } from "./capture-policy.js";
import { getSessionRunState } from "./state.js";
import {
  CONTEXT_COMMAND,
  CONTEXT_ENTRY_TYPE,
  CONTEXT_SCHEMA_VERSION,
  parseContextRequest,
  reconstructContext,
  sameOperation,
  summarizeContext,
  toOperation,
  type ContextOperationKind,
  type ContextState,
} from "./telemetry-context.js";
import { getCapturePolicy } from "./utils.js";

export interface ContextSessionManagerLike {
  getBranch?: () => readonly unknown[];
}

export interface ContextCommandContextLike {
  hasUI?: boolean;
  ui?: { notify?: (message: string, level?: "info" | "warning" | "error") => void };
  isIdle?: () => boolean;
  hasPendingMessages?: () => boolean;
  sessionManager?: ContextSessionManagerLike;
}

export interface ContextCommandDeps {
  /** Pi session ID resolved by the caller (the same ID used for trace sessions). */
  sessionId: string | undefined;
  /** `pi.appendEntry`; persists a non-model custom entry on the active branch. */
  appendEntry: (customType: string, data: unknown) => void;
  policy?: CapturePolicy;
}

export type ContextCommandStatus = "accepted" | "duplicate" | "rejected" | "status";

export interface ContextCommandResult {
  status: ContextCommandStatus;
  error?: string;
  context: ContextState;
}

const USAGE = `Usage: /${CONTEXT_COMMAND} set <JSON> | clear <JSON> | status`;

function notify(ctx: ContextCommandContextLike, message: string, level: "info" | "warning" | "error" = "info") {
  if (ctx.hasUI && ctx.ui?.notify) {
    ctx.ui.notify(message, level);
    return;
  }
  // Never stdout: in RPC/JSON modes stdout carries protocol records.
  console.error(`Langfuse context: ${message}`);
}

/**
 * Rebuilds the active session's context from its current branch and caches it
 * in the session run state. Returns the cached state when the session manager
 * cannot provide a branch.
 */
export function refreshTelemetryContext(
  sessionManager: ContextSessionManagerLike | undefined,
  sessionId: string | undefined,
  policy: CapturePolicy = getCapturePolicy(),
): ContextState {
  const sessionState = getSessionRunState();
  let branch: readonly unknown[] | undefined;
  try {
    branch = sessionManager?.getBranch?.();
  } catch {
    branch = undefined;
  }
  if (!Array.isArray(branch)) {
    return sessionState.telemetryContext;
  }
  sessionState.telemetryContext = reconstructContext(branch, sessionId, policy);
  return sessionState.telemetryContext;
}

/** Context attributes for the session's next trace; immutable once accepted. */
export function currentTelemetryContext(): ContextState {
  return getSessionRunState().telemetryContext;
}

export function formatContextStatus(context: ContextState): string {
  const lines = [
    `Langfuse context (schema v${CONTEXT_SCHEMA_VERSION}, revision ${context.revision}): ${summarizeContext(context)}`,
  ];
  if (context.lastOperationId) {
    lines.push(`Last operation: ${context.lastOperation} ${context.lastOperationId}`);
  }
  if (context.inheritedEntries > 0) {
    lines.push(`Ignored ${context.inheritedEntries} context entr${context.inheritedEntries === 1 ? "y" : "ies"} inherited from another session`);
  }
  if (context.ignoredEntries > 0) {
    lines.push(`Ignored ${context.ignoredEntries} malformed or unsupported context entr${context.ignoredEntries === 1 ? "y" : "ies"}`);
  }
  return lines.join("\n");
}

function busyReason(ctx: ContextCommandContextLike): string | undefined {
  // Pi's isIdle() is false during a run, automatic retries, compaction retries,
  // queued continuations and compaction/branch summarization.
  if (typeof ctx.isIdle !== "function" || typeof ctx.hasPendingMessages !== "function") {
    return "host cannot report idle state";
  }
  if (!ctx.isIdle()) {
    return "agent is busy";
  }
  if (ctx.hasPendingMessages()) {
    return "messages are queued";
  }
  return undefined;
}

function splitArgs(args: string): { subcommand: string; rest: string } {
  const trimmed = args.trim();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  return { subcommand: match?.[1] ?? "", rest: match?.[2]?.trim() ?? "" };
}

/**
 * `/langfuse-context set <JSON>`, `clear <JSON>` and `status`.
 *
 * Set replaces the whole custom context; clear writes an explicit tombstone.
 * Both are accepted only while Pi is fully idle and are idempotent by
 * operation ID on the active branch. Acceptance is observable as a persisted
 * `custom` entry of type `pi-langfuse.context` carrying the operation ID; the
 * notification is informational only.
 */
export function handleLangfuseContextCommand(
  args: string,
  ctx: ContextCommandContextLike,
  deps: ContextCommandDeps,
): ContextCommandResult {
  const policy = deps.policy ?? getCapturePolicy();
  const { subcommand, rest } = splitArgs(args);

  const reject = (error: string, context = currentTelemetryContext()): ContextCommandResult => {
    notify(ctx, `rejected: ${error}`, "error");
    return { status: "rejected", error, context };
  };

  if (subcommand === "status" || subcommand === "") {
    if (rest) {
      return reject(`unexpected argument. ${USAGE}`);
    }
    const context = refreshTelemetryContext(ctx.sessionManager, deps.sessionId, policy);
    notify(ctx, formatContextStatus(context));
    return { status: "status", context };
  }

  if (subcommand !== "set" && subcommand !== "clear") {
    return reject(`unknown subcommand. ${USAGE}`);
  }
  const op: ContextOperationKind = subcommand;

  if (!deps.sessionId) {
    return reject("no Pi session ID");
  }
  if (typeof ctx.sessionManager?.getBranch !== "function") {
    return reject("host cannot read the session branch");
  }
  const busy = busyReason(ctx);
  if (busy) {
    return reject(`${busy}; change context only while Pi is idle`);
  }

  const parsed = parseContextRequest(op, rest, policy);
  if (!parsed.ok) {
    return reject(parsed.error);
  }
  const request = parsed.value;

  const before = refreshTelemetryContext(ctx.sessionManager, deps.sessionId, policy);
  const existing = before.operations.get(request.operationId);
  if (existing) {
    if (!sameOperation(existing, request)) {
      return reject("operationId was already used for a different operation", before);
    }
    notify(ctx, `already applied ${op} ${request.operationId}`);
    return { status: "duplicate", context: before };
  }

  try {
    deps.appendEntry(CONTEXT_ENTRY_TYPE, toOperation(request, deps.sessionId));
  } catch (error) {
    return reject(`could not persist context: ${error instanceof Error ? error.message : String(error)}`, before);
  }

  const after = refreshTelemetryContext(ctx.sessionManager, deps.sessionId, policy);
  notify(ctx, `${op === "set" ? "set" : "cleared"} (revision ${after.revision}): ${summarizeContext(after)}`);
  return { status: "accepted", context: after };
}
