import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkItem, WorkStatus } from "../types";

type AttentionLane = "mainline" | "background" | "decision" | "review" | "parking";

const LANES: { id: AttentionLane; title: string; subtitle: string; empty: string }[] = [
  { id: "mainline", title: "今日主线", subtitle: "你明确选择、今天优先推动的结果", empty: "从上方候选任务中选择今天的主线" },
  { id: "background", title: "后台执行", subtitle: "Codex 正在推进、暂时不需要你介入", empty: "当前没有后台执行任务" },
  { id: "decision", title: "等待决定", subtitle: "需要你作出业务或风险判断", empty: "当前没有等待决定的任务" },
  { id: "review", title: "待验收", subtitle: "Codex 已提交结果，等待你的确认", empty: "当前没有待验收任务" },
  { id: "parking", title: "停车场", subtitle: "有价值，但现在不占用注意力", empty: "当前没有暂停推进的任务" },
];

const STATUS_LABELS: Record<WorkStatus, string> = {
  inbox: "待整理", ready: "可启动", active: "执行中", awaiting_decision: "等决定", in_review: "待验收",
  blocked: "已阻塞", parked: "已暂停", done: "已完成", canceled: "已取消",
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body as T;
}

function laneFor(item: WorkItem): AttentionLane | null {
  if (item.status === "awaiting_decision") return "decision";
  if (item.status === "in_review") return "review";
  if (item.status === "parked") return "parking";
  if (item.todayFocus && !["done", "canceled"].includes(item.status)) return "mainline";
  if (item.status === "active") return "background";
  return null;
}

function relativeTime(value: string) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const [amount, unit] = abs < 60 ? [seconds, "second"] : abs < 3600 ? [Math.round(seconds / 60), "minute"] : abs < 86400 ? [Math.round(seconds / 3600), "hour"] : [Math.round(seconds / 86400), "day"];
  return new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" }).format(amount, unit as Intl.RelativeTimeFormatUnit);
}

export default function TodayWorkspace() {
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [candidateId, setCandidateId] = useState("");

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const data = await api<{ workItems: WorkItem[] }>("/api/work-items");
      setWorkItems(data.workItems);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取今日工作台");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function setTodayFocus(item: WorkItem, todayFocus: boolean) {
    setSavingId(item.id);
    try {
      await api(`/api/work-items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: item.version, todayFocus }),
      });
      setCandidateId("");
      await load(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "今日主线更新失败");
      await load(true);
    } finally {
      setSavingId(null);
    }
  }

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return workItems.filter((item) => !item.hidden && (!normalized || [item.title, item.goal, item.nextAction, item.project || "", ...item.tags].join(" ").toLocaleLowerCase("zh-CN").includes(normalized)));
  }, [workItems, query]);

  const groups = useMemo(() => Object.fromEntries(LANES.map((lane) => [lane.id, visible.filter((item) => laneFor(item) === lane.id)])) as Record<AttentionLane, WorkItem[]>, [visible]);
  const candidates = useMemo(() => workItems.filter((item) => !item.hidden && !item.todayFocus && ["ready", "active", "blocked"].includes(item.status)), [workItems]);
  const selectedCandidate = candidates.find((item) => item.id === candidateId) || null;
  const attentionCount = groups.decision.length + groups.review.length;

  return <main className="workspace-shell today-shell">
    <header className="topbar">
      <div className="brand-area"><div className="brand"><span className="brand-mark"><img src="/app-icon-192.png" alt=""/></span><div><strong>Codex Workbench</strong><span>人的注意力与工作结果</span></div></div></div>
      <label className="search-box"><span aria-hidden>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工作任务、目标或下一步"/></label>
      <div className="top-actions"><button className="icon-button" onClick={() => void load()} title="刷新今日工作台" aria-label="刷新今日工作台">↻</button></div>
    </header>

    <section className="page-heading today-heading">
      <nav className="page-tabs" aria-label="任务页面"><a className="active" href="/today">今日工作台</a><a href="/">任务看板</a><a href="/completed">已完成</a><a href="/favorites">收藏</a></nav>
      <div className="summary-strip"><div><span>今日主线</span><strong>{groups.mainline.length}</strong></div><i/><div><span>后台执行</span><strong>{groups.background.length}</strong></div><i/><div><span>需要我</span><strong>{attentionCount}</strong></div></div>
    </section>

    <section className="today-planner">
      <div><strong>安排今日主线</strong><span>由你选择，Codex 不会自动改变计划</span></div>
      <select value={candidateId} onChange={(event) => setCandidateId(event.target.value)} aria-label="选择今日主线候选任务">
        <option value="">选择候选任务…</option>
        {candidates.map((item) => <option value={item.id} key={item.id}>{item.title} · {STATUS_LABELS[item.status]}</option>)}
      </select>
      <button disabled={!selectedCandidate || savingId !== null} onClick={() => selectedCandidate && void setTodayFocus(selectedCandidate, true)}>{savingId === selectedCandidate?.id ? "保存中…" : "设为今日主线"}</button>
    </section>

    {error && <div className="error-banner">{error}<button onClick={() => void load()}>重新读取</button></div>}

    <section className="today-board">
      {LANES.map((lane) => <section className={`attention-lane attention-${lane.id}`} key={lane.id}>
        <header><div><span/><h2>{lane.title}</h2><b>{groups[lane.id].length}</b></div><p>{lane.subtitle}</p></header>
        <div className="attention-list">
          {loading ? <TodaySkeleton/> : groups[lane.id].length ? groups[lane.id].map((item) => <WorkItemCard item={item} lane={lane.id} saving={savingId === item.id} onRemoveFocus={() => void setTodayFocus(item, false)} key={item.id}/>) : <div className="attention-empty"><strong>暂无任务</strong><p>{lane.empty}</p></div>}
        </div>
      </section>)}
    </section>
  </main>;
}

function WorkItemCard({ item, lane, saving, onRemoveFocus }: { item: WorkItem; lane: AttentionLane; saving: boolean; onRemoveFocus: () => void }) {
  return <article className="work-item-card">
    <div className="work-item-meta"><span>{item.project || "未归项目"}</span><b>{STATUS_LABELS[item.status]}</b></div>
    <h3>{item.title}</h3>
    <dl><div><dt>目标</dt><dd>{item.goal || "未提供"}</dd></div><div><dt>下一步</dt><dd>{item.nextAction || "未提供"}</dd></div></dl>
    <footer><span>{relativeTime(item.updatedAt)}更新 · v{item.version}</span>{lane === "mainline" && <button disabled={saving} onClick={onRemoveFocus}>{saving ? "保存中…" : "移出主线"}</button>}</footer>
  </article>;
}

function TodaySkeleton() {
  return <>{[1, 2].map((item) => <div className="today-skeleton" key={item}><i/><b/><span/></div>)}</>;
}
