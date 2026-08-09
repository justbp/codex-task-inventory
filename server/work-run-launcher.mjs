import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { WorkItemError } from "./work-items.mjs";
import { buildContextEnvelopePrompt } from "./work-context.mjs";

function assertWorkingDirectory(cwd) {
  if (!cwd || !isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new WorkItemError(409, "启动 Codex 前必须为 Work Item 配置有效的绝对 cwd", "invalid_work_item_cwd");
  }
}

function previousThread(workItems, workItemId, currentRunId) {
  return workItems.listRuns(workItemId)
    .filter((run) => run.id !== currentRunId && run.codexThreadId)
    .at(-1)?.codexThreadId || null;
}

export function createWorkRunLauncher({ workItems, workContext, workReview, launcher, wipPolicy }) {
  async function start(workItemId, input = {}, attribution = {}) {
    const item = workItems.get(workItemId);
    if (!item) throw new WorkItemError(404, "工作任务不存在", "work_item_not_found");
    assertWorkingDirectory(item.cwd);

    const mode = input.mode || "implementation";
    const threadStrategy = input.threadStrategy || "continue";
    if (!["continue", "new"].includes(threadStrategy)) {
      throw new WorkItemError(400, "threadStrategy 只能是 continue 或 new", "invalid_thread_strategy");
    }
    const envelope = workContext.buildEnvelope(workItemId, {
      expectedVersion: input.expectedVersion,
      mode,
      objective: input.objective,
      expectedOutput: input.expectedOutput,
    });
    let wipWarnings = [];
    const created = workItems.createRun(workItemId, {
      status: "queued",
      objective: envelope.run.objective,
      mode,
      expectedOutput: envelope.run.expectedOutput,
      contextEnvelope: envelope,
      contextWorkItemVersion: envelope.workItem.version,
      expectedWorkItemVersion: input.expectedVersion,
      launchState: "pending",
      threadStrategy,
    }, attribution, input.idempotencyKey, {
      beforeCreate() {
        wipWarnings = wipPolicy?.checkRunStart().warnings || [];
      },
    });

    let run = workItems.getRun(created.id);
    if (run.launchState !== "pending") {
      return {
        run,
        launched: run.launchState === "started",
        replayed: true,
        wipWarnings: [],
        deepLink: run.codexThreadId ? `codex://threads/${run.codexThreadId}` : null,
      };
    }

    run = workItems.claimLaunch(run.id, run.version, attribution);
    const resumeThreadId = threadStrategy === "continue" ? previousThread(workItems, workItemId, run.id) : null;
    let boundThreadId = null;
    try {
      const result = await launcher.launch({
        cwd: item.cwd,
        prompt: buildContextEnvelopePrompt(envelope, { runId: run.id }),
        threadId: resumeThreadId,
        onThreadReady: ({ threadId }) => {
          boundThreadId = threadId;
          run = workItems.recordLaunch(run.id, run.version, {
            launchState: "launching",
            codexThreadId: threadId,
          }, attribution);
        },
        onTurnStarted: ({ threadId, turnId }) => {
          run = workItems.recordLaunch(run.id, run.version, {
            status: "running",
            launchState: "started",
            codexThreadId: threadId,
            codexTurnId: turnId,
          }, attribution);
        },
        onTurnCompleted: (event) => workReview.processTurnCompleted(run.id, event),
        onLifecycleError: (error) => console.error(`Run ${run.id} lifecycle synchronization failed`, error),
      });
      run = workItems.getRun(run.id);
      return { run, launched: true, replayed: false, resumed: result.resumed, deepLink: result.deepLink, wipWarnings };
    } catch (error) {
      const current = workItems.getRun(run.id);
      const uncertain = Boolean(boundThreadId || current.codexThreadId);
      run = workItems.recordLaunch(current.id, current.version, {
        status: "failed",
        launchState: uncertain ? "uncertain" : "failed",
        launchError: error instanceof Error ? error.message : String(error),
      }, attribution);
      const wrapped = new WorkItemError(502, uncertain
        ? "Codex 启动结果不确定；已保留 Run，请检查绑定的 task，勿用同一请求自动重试"
        : "Codex 启动失败；已保留 Run 记录",
      uncertain ? "codex_launch_uncertain" : "codex_launch_failed");
      wrapped.details = { run };
      throw wrapped;
    }
  }

  return { start };
}
