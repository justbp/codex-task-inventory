import { useCallback, useEffect, useMemo, useState } from "react";
import type { BoardManagerInboxItem, BoardManagerResult, BoardManagerSuggestion } from "../types";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body as T;
}

const FIELD_LABELS: Record<string, string> = {
  title: "标题", description: "背景", goal: "目标", nextAction: "下一步", project: "项目", tags: "标签", status: "状态", stage: "阶段",
};

function display(value: unknown) {
  if (Array.isArray(value)) return value.length ? value.join("、") : "空";
  if (value === null || value === undefined || value === "") return "未提供";
  return String(value);
}

function originalValue(item: BoardManagerInboxItem | undefined, field: string) {
  if (!item) return "未提供";
  if (field === "description") return item.summary;
  if (field === "status") return "inbox";
  if (field === "stage") return "explore";
  return display(item[field as keyof BoardManagerInboxItem]);
}

export default function InboxOrganizerPanel({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const [result, setResult] = useState<BoardManagerResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");

  const loadCall = useCallback(async (id: string) => {
    const next = await api<BoardManagerResult>(`/api/board-manager/calls/${id}`);
    setResult(next);
    return next;
  }, []);

  const startNew = useCallback(async () => {
    setLoading(true);
    setSelected(new Set());
    const started = await api<BoardManagerResult>("/api/board-manager/inbox-organize", {
      method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    });
    setResult(started);
    setError("");
    setLoading(false);
    return started;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const latest = await api<{ result: BoardManagerResult | null }>("/api/board-manager/calls/latest");
        if (cancelled) return;
        if (latest.result && (["queued", "running"].includes(latest.result.call.status) || latest.result.suggestions.some((suggestion) => suggestion.state === "pending"))) {
          setResult(latest.result);
        } else {
          await startNew();
        }
        if (!cancelled) setError("");
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法调用看板管家");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [startNew]);

  useEffect(() => {
    if (!result || !["queued", "running"].includes(result.call.status)) return;
    const timer = window.setInterval(() => void loadCall(result.call.id).catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取整理结果")), 900);
    return () => window.clearInterval(timer);
  }, [loadCall, result?.call.id, result?.call.status]);

  const applicable = useMemo(() => result?.suggestions.filter((suggestion) => suggestion.kind === "update_work_item" && suggestion.state === "pending") || [], [result]);

  async function applySelected() {
    if (!result || !selected.size) return;
    setApplying(true);
    try {
      await api(`/api/board-manager/calls/${result.call.id}/apply`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), suggestionIds: [...selected] }),
      });
      setSelected(new Set());
      await loadCall(result.call.id);
      onApplied();
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "应用建议失败");
      await loadCall(result.call.id).catch(() => undefined);
    } finally {
      setApplying(false);
    }
  }

  function toggle(id: string, checked: boolean) {
    setSelected((current) => { const next = new Set(current); checked ? next.add(id) : next.delete(id); return next; });
  }

  return <><div className="manager-scrim" onClick={onClose}/><aside className="manager-drawer" aria-label="看板管家整理收集箱">
    <header className="manager-header"><div><span>BOARD MANAGER</span><strong>整理收集箱</strong><small>只读取必要摘要，确认前不会修改任务</small></div><button aria-label="关闭看板管家" onClick={onClose}>×</button></header>
    <div className="manager-content">
      {loading && <div className="manager-running"><i/><strong>正在准备收集箱摘要…</strong><p>不会读取任务对话和运行日志</p></div>}
      {!loading && result && ["queued", "running"].includes(result.call.status) && <div className="manager-running"><i/><strong>Codex 正在整理 {result.call.inputItemCount} 个收集箱任务</strong><p>你可以关闭面板，整理会在后台继续</p></div>}
      {result?.call.status === "completed" && <>
        <section className="manager-summary"><span>整理结果</span><strong>{result.call.summary || "没有生成变更建议"}</strong><p>共读取 {result.call.inputItemCount} 个任务，生成 {result.suggestions.length} 条建议</p></section>
        <div className="manager-suggestion-list">
          {result.suggestions.length ? result.suggestions.map((suggestion) => <SuggestionCard suggestion={suggestion} original={result.call.input.inboxItems.find((item) => item.id === suggestion.workItemId)} related={result.call.input.inboxItems.find((item) => item.id === suggestion.relatedWorkItemId)} selected={selected.has(suggestion.id)} onToggle={(checked) => toggle(suggestion.id, checked)} key={suggestion.id}/>) : <div className="manager-empty"><strong>收集箱不需要调整</strong><p>任务事实没有发生变化。</p></div>}
        </div>
      </>}
      {result && ["failed", "uncertain"].includes(result.call.status) && <div className="manager-failed"><strong>{result.call.status === "uncertain" ? "调用结果不确定" : "整理失败"}</strong><p>{result.call.error || "请稍后重新发起"}</p></div>}
      {error && <p className="manager-error">{error}</p>}
    </div>
    <footer className="manager-footer"><div>{result?.call.sourceUri && <a href={result.call.sourceUri}>查看本次管家调用</a>}<span>管家不能启动 Run 或标记完成</span></div>{result?.call.status === "completed" && <button className="secondary" disabled={applying || loading} onClick={() => void startNew().catch((reason) => { setLoading(false); setError(reason instanceof Error ? reason.message : "无法重新整理"); })}>重新整理</button>}<button className="secondary" onClick={onClose}>关闭</button>{result?.call.status === "completed" && applicable.length > 0 && <button className="primary" disabled={!selected.size || applying} onClick={() => void applySelected()}>{applying ? "应用中…" : `应用所选建议（${selected.size}）`}</button>}</footer>
  </aside></>;
}

function SuggestionCard({ suggestion, original, related, selected, onToggle }: { suggestion: BoardManagerSuggestion; original?: BoardManagerInboxItem; related?: BoardManagerInboxItem; selected: boolean; onToggle: (checked: boolean) => void }) {
  const applicable = suggestion.kind === "update_work_item";
  return <article className={`manager-suggestion ${suggestion.state === "applied" ? "applied" : ""}`}>
    <header>{applicable ? <label><input type="checkbox" disabled={suggestion.state === "applied"} checked={suggestion.state === "applied" || selected} onChange={(event) => onToggle(event.target.checked)}/><span>{suggestion.state === "applied" ? "已应用" : "选择"}</span></label> : <span className="info-only">仅提示</span>}<b>{suggestion.title}</b></header>
    <p>{suggestion.reason || "未提供理由"}</p>
    {applicable ? <dl>{Object.entries(suggestion.patch).map(([field, next]) => <div key={field}><dt>{FIELD_LABELS[field] || field}</dt><dd><del>{originalValue(original, field)}</del><span>→</span><ins>{display(next)}</ins></dd></div>)}</dl> : <div className="duplicate-note"><span>疑似关联</span><strong>{original?.title || suggestion.workItemId}</strong><span>↔</span><strong>{related?.title || suggestion.relatedWorkItemId}</strong></div>}
    <footer>{suggestion.impact || (applicable ? "确认后更新 Work Item" : "需要你判断是否合并")}</footer>
  </article>;
}
