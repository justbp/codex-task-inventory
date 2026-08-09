import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { DecisionRequest, ReviewSubmission, WorkItemDetail, WorkItemRun, WorkStatus } from "../types";

type ReviewMode = "approve" | "request_changes" | "accept_with_follow_up";

const STATUS_LABELS: Record<WorkStatus, string> = {
  inbox: "待整理", ready: "可启动", active: "执行中", awaiting_decision: "等待决定", in_review: "待验收",
  blocked: "已阻塞", parked: "停车场", done: "已完成", canceled: "已取消",
};
const RUN_LABELS: Record<WorkItemRun["status"], string> = {
  queued: "排队中", running: "执行中", waiting: "等待决定", completed: "已完成", interrupted: "已中断", failed: "失败", canceled: "已取消",
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body as T;
}

function formatTime(value: string | null) {
  if (!value) return "暂无";
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function Lines({ values, empty = "未提供" }: { values: string[]; empty?: string }) {
  return values.length ? <ul>{values.map((value, index) => <li key={`${value}-${index}`}>{value}</li>)}</ul> : <p className="detail-empty-text">{empty}</p>;
}

export default function WorkItemDetailDrawer({ workItemId, onClose, onChanged }: { workItemId: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const [detail, setDetail] = useState<WorkItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [decisionOption, setDecisionOption] = useState("");
  const [decisionText, setDecisionText] = useState("");
  const [decisionKey, setDecisionKey] = useState("");
  const [reviewMode, setReviewMode] = useState<ReviewMode>("approve");
  const [feedback, setFeedback] = useState("");
  const [followUpTitle, setFollowUpTitle] = useState("");
  const [followUpDescription, setFollowUpDescription] = useState("");
  const [followUpGoal, setFollowUpGoal] = useState("");
  const [followUpNextAction, setFollowUpNextAction] = useState("");
  const [reviewKey, setReviewKey] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<{ detail: WorkItemDetail }>(`/api/work-items/${workItemId}/detail`);
      setDetail(result.detail);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "任务详情读取失败");
    } finally {
      setLoading(false);
    }
  }, [workItemId]);

  useEffect(() => { void load(); }, [load]);

  const pendingDecision = useMemo(() => detail?.decisionRequests.findLast((item) => item.status === "pending") || null, [detail]);
  const latestReview = detail?.reviews.at(-1) || null;
  const latestReviewAction = latestReview ? detail?.reviewActions.find((item) => item.reviewSubmissionId === latestReview.id) || null : null;
  const latestRecovery = detail?.context.recoveryPoints.at(-1) || null;

  async function refreshAfterMutation() {
    await Promise.all([load(), onChanged()]);
  }

  async function answerDecision(event: FormEvent) {
    event.preventDefault();
    if (!detail || !pendingDecision) return;
    const run = detail.runs.find((item) => item.id === pendingDecision.runId);
    if (!run) return setError("Decision Request 对应的 Run 不存在");
    if (!decisionOption && !decisionText.trim()) return setError("请选择一个选项或填写补充回答");
    const key = decisionKey || crypto.randomUUID();
    if (!decisionKey) setDecisionKey(key);
    setSubmitting(true); setError("");
    try {
      await api(`/api/decision-requests/${pendingDecision.id}/answer`, {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: key,
          expectedVersion: pendingDecision.version,
          expectedRunVersion: run.version,
          expectedWorkItemVersion: detail.workItem.version,
          optionId: decisionOption || null,
          answerText: decisionText,
        }),
      });
      setDecisionKey(""); setDecisionText(""); setDecisionOption("");
      await refreshAfterMutation();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "决定发送失败";
      await refreshAfterMutation();
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitReview(event: FormEvent) {
    event.preventDefault();
    if (!detail || !latestReview) return;
    if (reviewMode === "request_changes" && !feedback.trim()) return setError("退回修改必须填写验收意见");
    if (reviewMode === "accept_with_follow_up" && !followUpTitle.trim()) return setError("请填写后续任务名称");
    const key = reviewKey || crypto.randomUUID();
    if (!reviewKey) setReviewKey(key);
    setSubmitting(true); setError("");
    try {
      await api(`/api/reviews/${latestReview.id}/actions`, {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: key,
          action: reviewMode,
          expectedReviewVersion: latestReview.version,
          expectedWorkItemVersion: detail.workItem.version,
          feedback,
          ...(reviewMode === "accept_with_follow_up" ? { followUp: {
            title: followUpTitle,
            description: followUpDescription,
            goal: followUpGoal,
            nextAction: followUpNextAction,
            project: detail.workItem.project,
            cwd: detail.workItem.cwd,
            tags: detail.workItem.tags,
            priority: detail.workItem.priority,
            stage: "explore",
          } } : {}),
        }),
      });
      setReviewKey("");
      await refreshAfterMutation();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "验收操作失败";
      await refreshAfterMutation();
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return <><div className="work-detail-scrim" onClick={onClose}/><aside className="work-detail-drawer" aria-label="工作任务详情">
    <header className="work-detail-header">
      <div><span>WORK ITEM</span><strong>{detail ? STATUS_LABELS[detail.workItem.status] : "读取中"}</strong></div>
      <button onClick={onClose} aria-label="关闭工作任务详情">×</button>
    </header>
    {loading && !detail ? <div className="work-detail-loading">正在组装任务事实…</div> : detail ? <div className="work-detail-content">
      <section className="work-detail-title"><p>{detail.workItem.project || "未归项目"} · {detail.workItem.stage} · v{detail.workItem.version}</p><h2>{detail.workItem.title}</h2><span>{detail.workItem.description || "暂无任务说明"}</span></section>

      {error && <div className="detail-error">{error}<button onClick={() => void load()}>重新读取</button></div>}

      <DetailSection title="任务事实" subtitle="Work Item 是事实来源">
        <div className="detail-fact-grid"><Fact label="目标" value={detail.workItem.goal}/><Fact label="下一步" value={detail.workItem.nextAction}/><Fact label="允许范围" value={detail.workItem.scope.allowed}/><Fact label="排除范围" value={detail.workItem.scope.excluded}/></div>
        <div className="detail-list-block"><h4>验收标准</h4><Lines values={detail.workItem.acceptanceCriteria}/></div>
        <div className="detail-list-block"><h4>约束与停止条件</h4><Lines values={[...detail.workItem.constraints, ...detail.workItem.stopConditions]}/></div>
        <div className="detail-list-block"><h4>已确认决定</h4><Lines values={detail.context.decisions.map((item) => `${item.decision}${item.reason ? `（${item.reason}）` : ""}`)} empty="尚无已确认决定"/></div>
        <div className="detail-list-block"><h4>任务关系</h4><Lines values={detail.context.relations.map((item) => `${item.relationType} → ${item.targetWorkItemId}`)} empty="尚无关联任务"/></div>
      </DetailSection>

      <DetailSection title="需要你的决定" subtitle={`${detail.decisionRequests.length} 条 Decision Request`} emphasis={Boolean(pendingDecision)}>
        {pendingDecision ? <DecisionForm request={pendingDecision} optionId={decisionOption} answerText={decisionText} submitting={submitting} onOption={setDecisionOption} onText={setDecisionText} onSubmit={answerDecision}/> : detail.decisionRequests.length ? <DecisionHistory requests={detail.decisionRequests}/> : <p className="detail-empty-text">当前没有 Decision Request。</p>}
      </DetailSection>

      <DetailSection title="验收结果" subtitle={`${detail.reviews.length} 次 Review Submission`} emphasis={detail.workItem.status === "in_review"}>
        {latestReview ? <><ReviewReport review={latestReview}/>{latestReviewAction ? <p className={`resolved-action state-${latestReviewAction.state}`}>本次验收已处理：{reviewActionLabel(latestReviewAction.action)} · {latestReviewAction.state}{latestReviewAction.error ? ` · ${latestReviewAction.error}` : ""}</p> : detail.workItem.status === "in_review" ? <ReviewForm mode={reviewMode} feedback={feedback} followUp={{ title: followUpTitle, description: followUpDescription, goal: followUpGoal, nextAction: followUpNextAction }} submitting={submitting} onMode={(mode) => { setReviewMode(mode); setReviewKey(""); }} onFeedback={setFeedback} onFollowUp={{ title: setFollowUpTitle, description: setFollowUpDescription, goal: setFollowUpGoal, nextAction: setFollowUpNextAction }} onSubmit={submitReview}/> : null}</> : <p className="detail-empty-text">Codex 尚未提交验收结果。</p>}
      </DetailSection>

      <DetailSection title="执行历史" subtitle={`${detail.runs.length} 次 Run`}>
        <div className="run-timeline">{[...detail.runs].reverse().map((run) => <article key={run.id}><i className={`run-state-${run.status}`}/><div><header><strong>{RUN_LABELS[run.status]}</strong><span>{formatTime(run.terminalAt || run.updatedAt)}</span></header><p>{run.objective || "未提供执行目标"}</p><small>{run.mode} · Context Work Item v{run.contextWorkItemVersion || "-"}</small>{run.codexThreadId && <a href={`codex://threads/${run.codexThreadId}${run.codexTurnId ? `?turn=${run.codexTurnId}` : ""}`}>打开对应 Codex 对话</a>}</div></article>)}</div>
      </DetailSection>

      <DetailSection title="恢复与证据" subtitle="只保存摘要和原始入口">
        {latestRecovery ? <div className="recovery-card"><strong>{latestRecovery.currentConclusion || "暂无当前结论"}</strong><p>下一步：{latestRecovery.nextAction}</p><Lines values={latestRecovery.unresolved} empty="没有记录未解决项"/></div> : <p className="detail-empty-text">尚未保存 Recovery Point。</p>}
        <div className="evidence-list">{detail.context.evidence.map((item) => <a href={item.uri} key={item.id}><strong>{item.label}</strong><span>{item.summary || item.kind}</span></a>)}</div>
      </DetailSection>
    </div> : <div className="work-detail-loading">{error || "任务详情不可用"}</div>}
  </aside></>;
}

function DetailSection({ title, subtitle, emphasis = false, children }: { title: string; subtitle: string; emphasis?: boolean; children: React.ReactNode }) {
  return <section className={`detail-section${emphasis ? " detail-emphasis" : ""}`}><header><div><h3>{title}</h3><p>{subtitle}</p></div></header>{children}</section>;
}

function Fact({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><p>{value || "未提供"}</p></div>; }

function DecisionForm({ request, optionId, answerText, submitting, onOption, onText, onSubmit }: { request: DecisionRequest; optionId: string; answerText: string; submitting: boolean; onOption: (value: string) => void; onText: (value: string) => void; onSubmit: (event: FormEvent) => void }) {
  return <form className="decision-form" onSubmit={onSubmit}><h4>{request.question}</h4><p>{request.contextSummary}</p>{request.recommendationReason && <div className="recommendation"><strong>Codex 推荐</strong><span>{request.options.find((item) => item.id === request.recommendedOptionId)?.label || "未指定"}：{request.recommendationReason}</span></div>}<div className="decision-options">{request.options.map((option) => <label className={option.id === request.recommendedOptionId ? "recommended" : ""} key={option.id}><input type="radio" name={`decision-${request.id}`} value={option.id} checked={optionId === option.id} onChange={() => onOption(option.id)}/><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}</div>{request.risks && <p className="decision-risk">风险：{request.risks}</p>}{request.defaultConsequence && <p className="decision-default">不处理的后果：{request.defaultConsequence}</p>}<textarea value={answerText} onChange={(event) => onText(event.target.value)} placeholder="补充说明（可选）" rows={3}/><button disabled={submitting}>{submitting ? "正在发送到原 Run…" : "确认决定并发送"}</button></form>;
}

function DecisionHistory({ requests }: { requests: DecisionRequest[] }) { return <div className="decision-history">{[...requests].reverse().map((item) => <article key={item.id}><strong>{item.question}</strong><span>{item.status} · {item.routingState}</span><p>{item.options.find((option) => option.id === item.answerOptionId)?.label || item.answerText || "未回答"}</p></article>)}</div>; }

function ReviewReport({ review }: { review: ReviewSubmission }) { return <div className="review-report"><Fact label="已完成" value={review.completedSummary}/><Fact label="验证结果" value={review.verificationSummary}/><Fact label="风险" value={review.risks}/><Fact label="建议下一步" value={review.suggestedNextAction}/><a href={review.sourceUri}>查看原 Run 证据</a></div>; }

function ReviewForm({ mode, feedback, followUp, submitting, onMode, onFeedback, onFollowUp, onSubmit }: { mode: ReviewMode; feedback: string; followUp: { title: string; description: string; goal: string; nextAction: string }; submitting: boolean; onMode: (mode: ReviewMode) => void; onFeedback: (value: string) => void; onFollowUp: { title: (value: string) => void; description: (value: string) => void; goal: (value: string) => void; nextAction: (value: string) => void }; onSubmit: (event: FormEvent) => void }) {
  return <form className="review-form" onSubmit={onSubmit}><div className="review-mode">{[["approve","通过"],["request_changes","退回修改"],["accept_with_follow_up","接受并建后续"]].map(([value, label]) => <button type="button" className={mode === value ? "active" : ""} onClick={() => onMode(value as ReviewMode)} key={value}>{label}</button>)}</div>{mode === "request_changes" && <textarea value={feedback} onChange={(event) => onFeedback(event.target.value)} placeholder="必须填写具体修改意见，系统会创建新的修订 Run" rows={4}/>} {mode === "accept_with_follow_up" && <div className="follow-up-fields"><input value={followUp.title} onChange={(event) => onFollowUp.title(event.target.value)} placeholder="后续任务名称（必填）"/><textarea value={followUp.description} onChange={(event) => onFollowUp.description(event.target.value)} placeholder="背景说明" rows={2}/><input value={followUp.goal} onChange={(event) => onFollowUp.goal(event.target.value)} placeholder="目标结果"/><input value={followUp.nextAction} onChange={(event) => onFollowUp.nextAction(event.target.value)} placeholder="下一步动作"/></div>}<p className="review-boundary">只有你确认“通过”或“接受并建后续”，当前 Work Item 才会进入 Done。</p><button className={`submit-review mode-${mode}`} disabled={submitting}>{submitting ? "正在处理…" : mode === "approve" ? "确认通过并完成任务" : mode === "request_changes" ? "确认退回并启动修订" : "确认完成并创建后续任务"}</button></form>;
}

function reviewActionLabel(action: "approve" | "request_changes" | "accept_with_follow_up") { return ({ approve: "通过", request_changes: "退回修改", accept_with_follow_up: "接受并创建后续任务" })[action]; }
