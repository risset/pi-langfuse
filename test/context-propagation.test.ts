import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";

import { BasicTracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import * as tracing from "@langfuse/tracing";
import { context } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";

import registerExtension from "../index.ts";
import { createCapturePolicy } from "../src/capture-policy.ts";
import { ensureOtelContextManager, forceShutdownRuntime, getRuntime } from "../src/langfuse.ts";
import { recordSessionCompaction } from "../src/handlers/session.ts";
import { clearAllSessionStates, runWithSession, state } from "../src/state.ts";
import { CONTEXT_ENTRY_TYPE } from "../src/telemetry-context.ts";

const META = "langfuse.trace.metadata.";

const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0,
  totalTokens: input + output, cost: { input: input / 100, output: output / 100, total: (input + output) / 100 } });

interface Harness {
  spans: ReadableSpan[];
  providerContexts: string[];
  session: any;
  dir: string;
  flush: () => Promise<void>;
}

/**
 * Runs a real in-process Pi session with this extension, the real Langfuse SDK
 * wrapper and an in-memory exporter, so assertions see the attributes actually
 * stamped on exported spans.
 */
async function withRealSession(run: (h: Harness) => Promise<void>) {
  const previousConfig = state.config;
  const previousProvider = tracing.getLangfuseTracerProvider();
  const originalFetch = globalThis.fetch;
  const spans: ReadableSpan[] = [];
  const providerContexts: string[] = [];
  const provider = new BasicTracerProvider({ spanProcessors: [new LangfuseSpanProcessor({
    publicKey: "pk_test", secretKey: "sk_test",
    exporter: { export: (batch, done) => { spans.push(...batch); done({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} },
  })] });
  // Report every trace as visible so the REST fallback never runs.
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  const dir = await mkdtemp(join(tmpdir(), "pi-langfuse-context-"));
  let session: any;
  try {
    clearAllSessionStates();
    ensureOtelContextManager(context, AsyncHooksContextManager);
    state.config = { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.invalid",
      capturePolicy: createCapturePolicy({ LANGFUSE_PRIVACY_PRESET: "full-debug" }) };
    const runtime = await getRuntime();
    await runtime.tracerProvider?.shutdown?.();
    runtime.tracerProvider = provider;
    tracing.setLangfuseTracerProvider(provider);

    const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
      await import("@earendil-works/pi-coding-agent");
    const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const aiPackage = pathToFileURL(findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent"))!);
    const { createAssistantMessageEventStream } = await import(new URL("./dist/utils/event-stream.js", aiPackage).href);
    const { Type } = await import(pathToFileURL(sdkRequire.resolve("typebox")).href);

    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
      modelsStorePath: join(dir, "models-store"), refreshOnCreate: false });
    modelRuntime.registerProvider("physical", { api: "test-api", apiKey: "test-key", baseUrl: "https://example.invalid",
      models: [{ id: "actual", name: "Actual", reasoning: false, input: ["text"],
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 }],
      streamSimple(model, ctx, options) {
        providerContexts.push(JSON.stringify(ctx));
        const stream = createAssistantMessageEventStream();
        void (async () => {
          await options?.onPayload?.({ model: model.id }, model);
          await options?.onResponse?.({ status: 200, headers: {} }, model);
          const messages = (ctx as { messages: Array<{ role: string }> }).messages;
          const callTool = messages.at(-1)?.role === "user";
          const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
            content: callTool ? [{ type: "toolCall", id: `outer-${messages.length}`, name: "outer", arguments: {} }]
              : [{ type: "text", text: "Done" }],
            stopReason: callTool ? "toolUse" : "stop", usage: usage(5, 2), timestamp: Date.now() };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
        })();
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [registerExtension, (pi) => {
        const tool = (name: string, execute: any) => pi.registerTool({ name, label: name, description: name,
          parameters: Type.Object({}), execute });
        tool("inner", async () => ({ content: [{ type: "text", text: "inner" }], details: undefined }));
        tool("outer", async (_id: string, _p: unknown, _s: unknown, _u: unknown, ctx: any) => {
          await ctx.executeTool("inner", {});
          return { content: [{ type: "text", text: "outer" }], details: undefined };
        });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime,
      model: modelRuntime.getModel("physical", "actual"), thinkingLevel: "off", resourceLoader: loader,
      settingsManager, sessionManager: SessionManager.inMemory(dir) }));
    const errors: string[] = [];
    await session.bindExtensions({ onError: (error: { error: string }) => { errors.push(error.error); } });
    await run({ spans, providerContexts, session, dir, flush: () => provider.forceFlush() });
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    await forceShutdownRuntime();
    await provider.shutdown();
    tracing.setLangfuseTracerProvider(previousProvider);
    state.config = previousConfig;
    clearAllSessionStates();
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
}

const traceOf = (spans: ReadableSpan[], traceId: string) => spans.filter((span) => span.spanContext().traceId === traceId);
const rootTraces = (spans: ReadableSpan[]) => spans.filter((span) => span.name === "pi-agent");

function setCommand(operationId: string, attributes: Record<string, string>) {
  return `/langfuse-context set ${JSON.stringify({ schemaVersion: 1, operationId, attributes })}`;
}

test("accepted context reaches the root and every descendant observation, without entering provider input", { timeout: 30_000 }, async () => withRealSession(async ({ spans, providerContexts, session, flush }) => {
  const attributes = { taskId: "task-a-0001", taskAttemptId: "attempt-a-0001", taskType: "review", workflowName: "review-pull-request" };
  await session.prompt(setCommand("op-a-000001", attributes));
  const entry = session.sessionManager.getBranch().find((e: any) => e.type === "custom" && e.customType === CONTEXT_ENTRY_TYPE);
  assert.equal(entry?.data.operationId, "op-a-000001");
  assert.equal(entry?.data.sessionId, session.sessionManager.getSessionId());

  await session.prompt("Run the tools");
  await flush();

  const [root] = rootTraces(spans);
  assert.ok(root, "a pi-agent root span is exported");
  const tree = traceOf(spans, root.spanContext().traceId);
  const names = tree.map((span) => span.name);
  for (const expected of ["pi-agent", "agent-attempt", "llm-generation", "outer", "inner"]) {
    assert.ok(names.includes(expected), `trace contains ${expected}: ${names.join(",")}`);
  }
  for (const span of tree) {
    for (const [key, value] of Object.entries(attributes)) {
      assert.equal(span.attributes[META + key], value, `${span.name} carries ${key}`);
    }
    assert.equal(span.attributes[META + "piContextRevision"], "1", `${span.name} carries the context revision`);
    assert.equal(span.attributes["session.id"], session.sessionManager.getSessionId());
  }
  // Generation identity stays authoritative.
  const generation = tree.find((span) => span.name === "llm-generation")!;
  assert.equal(generation.attributes["langfuse.observation.model.name"], "actual");
  assert.equal(tree.find((span) => span.name === "pi-agent")!.attributes[META + "model"], "actual");

  // The custom entry is not model context.
  assert.ok(providerContexts.length >= 2);
  for (const sent of providerContexts) {
    assert.doesNotMatch(sent, /task-a-0001|attempt-a-0001|op-a-000001|"customType"/);
  }
}));

test("each run snapshots the context accepted before it; clear and replace affect only later runs", { timeout: 30_000 }, async () => withRealSession(async ({ spans, session, flush }) => {
  await session.prompt("Untagged run");
  await session.prompt(setCommand("op-b-000001", { taskId: "task-b-0001", taskType: "advisory" }));
  await session.prompt("Tagged run");
  await session.prompt(setCommand("op-b-000002", { taskId: "task-c-0001" }));
  await session.prompt("Replaced run");
  await session.prompt(`/langfuse-context clear ${JSON.stringify({ schemaVersion: 1, operationId: "op-b-000003" })}`);
  await session.prompt("Cleared run");
  await flush();

  const roots = rootTraces(spans).sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1]);
  assert.equal(roots.length, 4);
  const tagged = roots.map((root) => traceOf(spans, root.spanContext().traceId));
  const ids = tagged.map((tree) => [...new Set(tree.map((span) => span.attributes[META + "taskId"] ?? null))]);
  assert.deepEqual(ids, [[null], ["task-b-0001"], ["task-c-0001"], [null]]);
  // Replace is not a merge: taskType from the previous context does not survive.
  assert.ok(tagged[2].every((span) => span.attributes[META + "taskType"] === undefined));
}));

test("idle standalone compaction traces stay session-only", { timeout: 30_000 }, async () => withRealSession(async ({ spans, session, flush }) => {
  await session.prompt(setCommand("op-d-000001", { taskId: "task-d-0001" }));
  await runWithSession(session.sessionManager.getSessionId(), () => recordSessionCompaction({
    reason: "manual", fromExtension: false, willRetry: false,
    compactionEntry: { id: "c1", summary: "s", firstKeptEntryId: "c1", tokensBefore: 10 },
  }));
  await flush();
  const compaction = spans.filter((span) => span.attributes["langfuse.trace.name"] === "pi-session");
  assert.ok(compaction.length > 0, "a standalone pi-session trace is exported");
  for (const span of compaction) {
    assert.equal(span.attributes[META + "taskId"], undefined);
    assert.equal(span.attributes[META + "piScope"], "session");
  }
}));

test("context changes are refused while a run is active", { timeout: 30_000 }, async () => withRealSession(async ({ session }) => {
  let rejected = false;
  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === "turn_start" && !rejected) {
      rejected = true;
      void session.prompt(setCommand("op-e-000001", { taskId: "task-e-0001" }));
    }
  });
  await session.prompt("Busy run");
  await session.agent.waitForIdle?.();
  unsubscribe();
  assert.equal(rejected, true);
  const entries = session.sessionManager.getEntries().filter((e: any) => e.customType === CONTEXT_ENTRY_TYPE);
  assert.equal(entries.length, 0);
}));
