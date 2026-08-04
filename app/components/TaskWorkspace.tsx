import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { CodexQuota, CodexQuotaWindow, CodexThread, Priority, TaskLane } from "../types";

const COLUMNS: { id: TaskLane; title: string; subtitle: string }[] = [
  { id: "inbox", title: "收集箱", subtitle: "新发现的 Codex 任务" },
  { id: "upcoming", title: "待办", subtitle: "可交给 Codex 开始处理" },
  { id: "in_progress", title: "进行中", subtitle: "由 Codex 运行态自动进入" },
  { id: "review", title: "待 Review", subtitle: "新一轮执行已经结束" },
];

type IconName = "logo" | "search" | "refresh" | "open" | "folder" | "pulse" | "close" | "check" | "plus" | "play" | "pin" | "star" | "trash";
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    logo: <><rect x="3" y="3" width="18" height="18" rx="6"/><path d="M8 12h8M12 8v8"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 9a7 7 0 0 1 12-2l2 5M4 12l2 5a7 7 0 0 0 12-2"/></>,
    open: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/></>,
    folder: <><path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h7l2 2"/></>,
    pulse: <path d="M3 12h4l2-5 4 10 2-5h6"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    plus: <path d="M12 5v14M5 12h14"/>,
    play: <path d="m9 6 9 6-9 6z"/>,
    pin: <><path d="m15 4 5 5-3 1-4 4v5l-2 2-2-6-6-2 2-2h5l4-4z"/><path d="m5 19 4-4"/></>,
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/><path d="M10 11v5M14 11v5"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{paths[name]}</svg>;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body as T;
}

function relativeTime(value: string | null) {
  if (!value) return "暂无";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const [amount, unit] = abs < 60 ? [seconds, "second"] : abs < 3600 ? [Math.round(seconds / 60), "minute"] : abs < 86400 ? [Math.round(seconds / 3600), "hour"] : [Math.round(seconds / 86400), "day"];
  return new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" }).format(amount, unit as Intl.RelativeTimeFormatUnit);
}

function quotaWindowLabel(window: CodexQuotaWindow | null) {
  const minutes = window?.windowDurationMins;
  if (!minutes) return "Codex 额度";
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}天额度`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}小时额度`;
  return `${minutes}分钟额度`;
}

function resetTimeLabel(value: string | null | undefined) {
  if (!value) return "刷新时间未知";
  const reset = new Date(value);
  if (Number.isNaN(reset.getTime())) return "刷新时间未知";
  const now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const time = reset.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (reset.toDateString() === now.toDateString()) return `${time} 刷新`;
  if (reset.toDateString() === tomorrow.toDateString()) return `明天 ${time} 刷新`;
  return `${reset.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} ${time} 刷新`;
}

function quotaTitle(quota: CodexQuota | null, error: string) {
  if (error) return error;
  if (!quota?.available || !quota.primary) return "当前登录方式未返回 Codex 额度";
  const primary = `${quotaWindowLabel(quota.primary)}：剩余 ${quota.primary.remainingPercent ?? "--"}%，${resetTimeLabel(quota.primary.resetsAt)}`;
  if (!quota.secondary) return primary;
  return `${primary}\n${quotaWindowLabel(quota.secondary)}：剩余 ${quota.secondary.remainingPercent ?? "--"}%，${resetTimeLabel(quota.secondary.resetsAt)}`;
}

function QuotaBadge({ quota, loading, error }: { quota: CodexQuota | null; loading: boolean; error: string }) {
  const available = quota?.available && quota.primary;
  return <div className={`quota-badge${available ? "" : " quota-unavailable"}`} title={quotaTitle(quota, error)} aria-live="polite">
    {available ? <><span className="quota-amount"><strong>{quota.primary?.remainingPercent ?? "--"}%</strong><small>{quotaWindowLabel(quota.primary)}</small></span><i/><span className="quota-reset">{resetTimeLabel(quota.primary?.resetsAt)}</span></> : <span className="quota-placeholder">{loading ? "额度读取中…" : "额度暂不可用"}</span>}
  </div>;
}

function inDoneRange(thread: CodexThread, range: string) {
  if (range === "all") return true;
  const date = new Date(thread.completedAt || thread.updatedAt);
  const now = new Date();
  if (range === "today") return date.toDateString() === now.toDateString();
  if (range === "month") return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  const start = new Date(now); start.setDate(now.getDate() - ((now.getDay() + 6) % 7)); start.setHours(0, 0, 0, 0);
  return date >= start;
}

type ProjectChoice = { name: string; paths: string[] };

function buildProjectChoices(threads: CodexThread[]): ProjectChoice[] {
  const choices = new Map<string, Set<string>>();
  for (const thread of threads) {
    const name = thread.project.trim();
    if (!name || name === "未归项目") continue;
    if (!choices.has(name)) choices.set(name, new Set());
    if (thread.cwd) choices.get(name)?.add(thread.cwd);
  }
  return [...choices.entries()].map(([name, paths]) => ({ name, paths: [...paths] })).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function pinnedFirst(items: CodexThread[]) {
  return [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}

export default function TaskWorkspace() {
  const completedPage = window.location.pathname === "/completed";
  const [threads, setThreads] = useState<CodexThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [quota, setQuota] = useState<CodexQuota | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(true);
  const [quotaError, setQuotaError] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("all");
  const [doneRange, setDoneRange] = useState("week");
  const [selected, setSelected] = useState<CodexThread | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [createLane, setCreateLane] = useState<"inbox" | "upcoming" | null>(null);
  const [reviewSelection, setReviewSelection] = useState<Set<string>>(new Set());
  const [visibleCounts, setVisibleCounts] = useState<Record<TaskLane, number>>({ inbox: 20, upcoming: 20, in_progress: 20, review: 20, completed: 20 });

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const data = await api<{ threads: CodexThread[] }>("/api/threads");
      setThreads(data.threads);
      setSelected((current) => current ? data.threads.find((item) => item.id === current.id) || null : null);
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取 Codex 任务"); }
    finally { if (!quiet) setLoading(false); }
  }, []);

  const loadQuota = useCallback(async (force = false) => {
    setQuotaLoading(true);
    try {
      const data = await api<{ quota: CodexQuota }>(`/api/quota${force ? "?refresh=1" : ""}`);
      setQuota(data.quota);
      setQuotaError("");
    } catch (reason) {
      setQuotaError(reason instanceof Error ? reason.message : "无法读取 Codex 额度");
    } finally { setQuotaLoading(false); }
  }, []);

  useEffect(() => { void load(); const events = new EventSource("/api/events"); events.addEventListener("threads-changed", () => void load(true)); return () => events.close(); }, [load]);
  useEffect(() => { void loadQuota(); const timer = window.setInterval(() => void loadQuota(), 60_000); return () => window.clearInterval(timer); }, [loadQuota]);

  const projectChoices = useMemo(() => buildProjectChoices(threads), [threads]);
  const projects = useMemo(() => [...new Set(threads.map((item) => item.project))].sort(), [threads]);
  const filtered = useMemo(() => threads.filter((item) => {
    const text = [item.title, item.preview, item.project, item.cwd, ...item.tags].join(" ").toLowerCase();
    return (!query.trim() || text.includes(query.trim().toLowerCase())) && (project === "all" || item.project === project);
  }), [threads, query, project]);
  const byLane = useMemo(() => Object.fromEntries(COLUMNS.map((column) => [column.id, pinnedFirst(filtered.filter((item) => item.lane === column.id))])) as Record<TaskLane, CodexThread[]>, [filtered]);
  const completed = useMemo(() => pinnedFirst(filtered.filter((item) => item.lane === "completed" && inDoneRange(item, doneRange))), [filtered, doneRange]);

  async function patch(id: string, change: Record<string, unknown>) {
    const item = threads.find((thread) => thread.id === id);
    await api(item?.kind === "manual" ? `/api/items/${id}` : `/api/threads/${id}`, { method: "PATCH", body: JSON.stringify(change) });
    await load(true);
  }

  async function batchReview(lane: "completed") {
    const selectedItems = [...reviewSelection].map((id) => threads.find((item) => item.id === id)).filter((item): item is CodexThread => Boolean(item));
    await Promise.all(selectedItems.map((item) => api(item.kind === "manual" ? `/api/items/${item.id}` : `/api/threads/${item.id}`, { method: "PATCH", body: JSON.stringify({ lane }) })));
    setReviewSelection(new Set());
    await load(true);
  }

  async function startManual(id: string) {
    const result = await api<{ deepLink: string }>(`/api/items/${id}/start`, { method: "POST", body: "{}" });
    return result.deepLink;
  }

  async function removeManual(thread: CodexThread) {
    if (thread.kind !== "manual" || !["inbox", "upcoming"].includes(thread.lane)) return;
    if (!window.confirm(`确定删除“${thread.title}”吗？此操作无法撤销。`)) return;
    await api(`/api/items/${thread.id}`, { method: "DELETE" });
    setSelected((current) => current?.id === thread.id ? null : current);
    await load(true);
  }

  const activeCount = threads.filter((item) => item.runtimeStatus === "active").length;
  const waitingCount = threads.filter((item) => item.runtimeStatus === "waiting").length;
  return <main className="workspace-shell">
    <header className="topbar">
      <div className="brand-area"><div className="brand"><span className="brand-mark"><Icon name="logo" size={21}/></span><div><strong>Codex Task Monitor</strong><span>本地任务盘点</span></div></div><QuotaBadge quota={quota} loading={quotaLoading} error={quotaError}/></div>
      <label className="search-box"><Icon name="search"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索对话、项目或路径"/></label>
      <div className="top-actions"><button className="icon-button" onClick={() => void Promise.all([load(), loadQuota(true)])} title="刷新任务和额度"><Icon name="refresh"/></button></div>
    </header>
    <section className="page-heading">
      <nav className="page-tabs" aria-label="任务页面"><a className={!completedPage ? "active" : ""} href="/">任务看板</a><a className={completedPage ? "active" : ""} href="/completed">已完成 <b>{threads.filter((item) => item.lane === "completed").length}</b></a></nav>
      <div className="summary-strip"><div><span>任务</span><strong>{threads.length}</strong></div><i/><div><span>执行中</span><strong>{activeCount}</strong></div><i/><div><span>等待我</span><strong>{waitingCount}</strong></div><i/><div><span>待检查</span><strong>{threads.filter((item) => item.lane === "review").length}</strong></div></div>
    </section>
    <section className="filterbar"><span className="source-pill"><i/>实时读取本机 Codex</span><select value={project} onChange={(event) => setProject(event.target.value)}><option value="all">全部项目</option>{projects.map((item) => <option key={item}>{item}</option>)}</select><span className="task-total">共 {completedPage ? completed.length : filtered.filter((item) => item.lane !== "completed").length} 个任务</span></section>
    {error && <div className="error-banner">{error}<button onClick={() => void load()}>重试</button></div>}
    {!completedPage ? <section className="board">
      {COLUMNS.map((column) => <section className={`board-column column-${column.id}`} key={column.id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/thread-id") || dragging; if (id && !["in_progress"].includes(column.id)) void patch(id, { lane: column.id }); setDragging(null); }}>
        <header className="column-header"><div><span className="status-dot"/><h2>{column.title}</h2><b>{byLane[column.id].length}</b></div>{["inbox", "upcoming"].includes(column.id) && <button className="column-create" onClick={() => setCreateLane(column.id as "inbox" | "upcoming")}><Icon name="plus" size={14}/>创建</button>}</header><p className="column-subtitle">{column.subtitle}</p>
        {column.id === "review" && byLane.review.length > 0 && <div className="review-toolbar"><button onClick={() => setReviewSelection(new Set(byLane.review.map((item) => item.id)))}>全选</button><span>{reviewSelection.size ? `已选 ${reviewSelection.size}` : "批量验收"}</span><button disabled={!reviewSelection.size} className="approve-selected" onClick={() => void batchReview("completed")}><Icon name="check" size={13}/>通过</button></div>}
        <div className="card-list">{loading ? <Loading/> : byLane[column.id].length ? <>{byLane[column.id].slice(0, visibleCounts[column.id]).map((thread) => <ThreadCard thread={thread} key={thread.id} onOpen={() => setSelected(thread)} onTogglePinned={() => void patch(thread.id, { pinned: !thread.pinned })} onDelete={thread.kind === "manual" && ["inbox", "upcoming"].includes(thread.lane) ? () => void removeManual(thread) : undefined} actionLabel="置顶" selectable={column.id === "review"} selected={reviewSelection.has(thread.id)} onSelect={(checked) => setReviewSelection((current) => { const next = new Set(current); checked ? next.add(thread.id) : next.delete(thread.id); return next; })} onDragStart={(event) => { setDragging(thread.id); event.dataTransfer.setData("text/thread-id", thread.id); }}/>) }{byLane[column.id].length > visibleCounts[column.id] && <button className="load-more" onClick={() => setVisibleCounts((counts) => ({ ...counts, [column.id]: counts[column.id] + 20 }))}>再显示 20 个 · 剩余 {byLane[column.id].length - visibleCounts[column.id]}</button>}</> : <div className="empty-column"><span>—</span><strong>暂无任务</strong><p>{column.id === "in_progress" ? "Codex 开始执行后会自动出现" : ["inbox", "upcoming"].includes(column.id) ? "点击列标题旁的创建按钮" : "拖入任务即可排布"}</p></div>}</div>
      </section>)}
    </section> : <section className="completed-page">
      <header className="completed-header"><div><h1>已完成</h1><p>集中查看已验收或已归档的任务</p></div><div className="date-segment">{[["today","今天"],["week","本周"],["month","本月"],["all","全部"]].map(([value,label]) => <button className={doneRange === value ? "active" : ""} onClick={() => setDoneRange(value)} key={value}>{label}</button>)}</div></header>
      <div className="completed-grid">{loading ? <Loading/> : completed.length ? completed.map((thread) => <ThreadCard thread={thread} key={thread.id} onOpen={() => setSelected(thread)} onTogglePinned={() => void patch(thread.id, { pinned: !thread.pinned })} actionLabel="收藏" selectable={false} selected={false} onSelect={() => {}} onDragStart={(event) => event.preventDefault()}/>) : <div className="completed-empty"><span>✓</span><strong>这个时间范围内没有已完成任务</strong><p>完成的任务会集中出现在这里。</p></div>}</div>
    </section>}
    {selected && <ThreadDrawer thread={selected} projectChoices={projectChoices} onClose={() => setSelected(null)} onPatch={(change) => patch(selected.id, change)} onStart={() => startManual(selected.id)} onDelete={() => removeManual(selected)}/>}
    {createLane && <CreateTaskModal initialLane={createLane} projectChoices={projectChoices} onClose={() => setCreateLane(null)} onCreated={async () => { setCreateLane(null); await load(true); }}/>}
  </main>;
}

function Loading() { return <>{[1,2].map((item) => <div className="card-skeleton" key={item}><i/><b/><span/></div>)}</>; }

function ThreadCard({ thread, onOpen, onDragStart, onTogglePinned, onDelete, actionLabel, selectable, selected, onSelect }: { thread: CodexThread; onOpen: () => void; onDragStart: React.DragEventHandler<HTMLElement>; onTogglePinned: () => void; onDelete?: () => void; actionLabel: "置顶" | "收藏"; selectable: boolean; selected: boolean; onSelect: (checked: boolean) => void }) {
  const runtime = thread.kind === "manual" ? "待处理" : thread.runtimeStatus === "active" ? "执行中" : thread.runtimeStatus === "waiting" ? "等待我" : thread.runtimeStatus === "interrupted" ? "已中断" : "已执行";
  return <article className={`task-card${thread.pinned ? " is-pinned" : ""}`} draggable={thread.runtimeStatus !== "active" && thread.runtimeStatus !== "waiting"} onDragStart={onDragStart} onClick={onOpen}>
    <div className="card-topline"><span className="project-name"><Icon name="folder" size={13}/>{thread.project}</span><div className="card-quick-actions"><button className={thread.pinned ? "active" : ""} onClick={(event) => { event.stopPropagation(); onTogglePinned(); }} title={thread.pinned ? `取消${actionLabel}` : actionLabel} aria-label={thread.pinned ? `取消${actionLabel}` : actionLabel}><Icon name={actionLabel === "收藏" ? "star" : "pin"} size={14}/></button>{onDelete && <button className="delete-action" onClick={(event) => { event.stopPropagation(); onDelete(); }} title="删除" aria-label="删除"><Icon name="trash" size={14}/></button>}</div></div>
    <span className={`runtime runtime-${thread.kind === "manual" ? "manual" : thread.runtimeStatus}`}><i/>{runtime}</span>
    {selectable && <label className="review-check" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selected} onChange={(event) => onSelect(event.target.checked)}/><span>选择验收</span></label>}
    <h3>{thread.title}</h3>
    <p className="task-description">{thread.lastProgress || thread.preview || "尚无进展摘要"}</p>
    {thread.tags.length > 0 && <div className="tag-row">{thread.tags.slice(0,3).map((tag) => <span key={tag}>#{tag}</span>)}</div>}
    <footer className="card-footer"><span><Icon name="pulse" size={14}/>{relativeTime(thread.lastProgressAt || thread.updatedAt)}</span>{thread.deepLink && <a href={thread.deepLink} onClick={(event) => event.stopPropagation()} title="回到 Codex 对话"><Icon name="open" size={15}/></a>}</footer>
  </article>;
}

function ProjectInput({ id, value, choices, onChange, onDirectorySuggested }: { id: string; value: string; choices: ProjectChoice[]; onChange: (value: string) => void; onDirectorySuggested?: (path: string) => void }) {
  function change(value: string) {
    onChange(value);
    const match = choices.find((choice) => choice.name === value);
    if (match?.paths[0]) onDirectorySuggested?.(match.paths[0]);
  }
  return <label className="field"><span>项目 <em>可选择或输入</em></span><input list={`${id}-projects`} value={value} onChange={(event) => change(event.target.value)} placeholder="选择已有项目或输入新项目"/><datalist id={`${id}-projects`}>{choices.map((choice) => <option value={choice.name} key={choice.name}/>)}</datalist></label>;
}

function DirectoryInput({ id, value, project, choices, onChange, hint }: { id: string; value: string; project: string; choices: ProjectChoice[]; onChange: (value: string) => void; hint: string }) {
  const projectPaths = choices.find((choice) => choice.name === project)?.paths || [];
  const paths = projectPaths.length ? projectPaths : [...new Set(choices.flatMap((choice) => choice.paths))];
  return <label className="field"><span>工作目录 <em>{hint}</em></span><input list={`${id}-paths`} value={value} onChange={(event) => onChange(event.target.value)} placeholder="选择已有目录或输入绝对路径"/><datalist id={`${id}-paths`}>{paths.map((path) => <option value={path} key={path}/>)}</datalist></label>;
}

function ThreadDrawer({ thread, projectChoices, onClose, onPatch, onStart, onDelete }: { thread: CodexThread; projectChoices: ProjectChoice[]; onClose: () => void; onPatch: (change: Record<string, unknown>) => Promise<void>; onStart: () => Promise<string>; onDelete: () => Promise<void> }) {
  const [project, setProject] = useState(thread.project);
  const [cwd, setCwd] = useState(thread.cwd);
  const [tags, setTags] = useState(thread.tags.join(", "));
  const [priority, setPriority] = useState<Priority>(thread.priority);
  const [note, setNote] = useState(thread.note);
  const [saving, setSaving] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [actionError, setActionError] = useState("");
  async function save() { setSaving(true); try { await onPatch({ project, cwd, tags: tags.split(",").map((item) => item.trim()).filter(Boolean), priority, note }); setActionError(""); } finally { setSaving(false); } }
  async function launch() {
    setLaunching(true); setActionError("");
    try {
      await onPatch({ project, cwd, tags: tags.split(",").map((item) => item.trim()).filter(Boolean), priority, note });
      const deepLink = await onStart();
      window.location.href = deepLink;
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : "无法启动 Codex"); }
    finally { setLaunching(false); }
  }
  return <><div className="drawer-scrim" onClick={onClose}/><aside className="task-drawer">
    <header className="drawer-header"><span className={`runtime runtime-${thread.kind === "manual" ? "manual" : thread.runtimeStatus}`}><i/>{thread.kind === "manual" ? "我的待办" : thread.runtimeStatus === "active" ? "Codex 正在执行" : thread.runtimeStatus === "waiting" ? "等待你的操作" : "Codex 任务"}</span><button className="icon-button" onClick={onClose}><Icon name="close"/></button></header>
    <div className="drawer-content"><p className="drawer-kicker">{thread.kind === "manual" ? "尚未发送给 Codex" : "真实 Codex 对话"}</p><h2>{thread.title}</h2><p className="drawer-preview">{thread.lastProgress || thread.preview || "尚未填写说明"}</p>
      {thread.kind === "codex" && <dl className="thread-facts"><div><dt>工作目录</dt><dd>{thread.cwd}</dd></div><div><dt>最近更新</dt><dd>{relativeTime(thread.updatedAt)}</dd></div><div><dt>最近文件变更</dt><dd>{relativeTime(thread.lastFileChangeAt)}</dd></div></dl>}
      <ProjectInput id={`drawer-${thread.id}`} value={project} choices={projectChoices} onChange={setProject} onDirectorySuggested={thread.kind === "manual" ? setCwd : undefined}/>
      {thread.kind === "manual" && <DirectoryInput id={`drawer-${thread.id}`} value={cwd} project={project} choices={projectChoices} onChange={setCwd} hint="必填，可选择或输入"/>}
      <label className="field"><span>标签 <em>逗号分隔</em></span><input value={tags} onChange={(event) => setTags(event.target.value)}/></label>
      <label className="field"><span>优先级</span><select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
      <label className="field"><span>我的备注</span><textarea value={note} onChange={(event) => setNote(event.target.value)} rows={5}/></label>
      {actionError && <p className="form-error">{actionError}</p>}
    </div>
    <footer className="drawer-footer"><div className="drawer-leading-actions">{thread.deepLink ? <a className="secondary-button" href={thread.deepLink}><Icon name="open"/>回到 Codex 对话</a> : thread.kind === "manual" && thread.lane === "upcoming" ? <button className="primary-button" disabled={launching || saving} onClick={() => void launch()}><Icon name="play"/>{launching ? "正在启动…" : "启动 Codex"}</button> : thread.kind === "manual" && thread.lane === "inbox" ? <span className="launch-hint">移入“待办”后可交给 Codex 启动</span> : <span/>}{thread.kind === "manual" && ["inbox", "upcoming"].includes(thread.lane) && <button className="secondary-button danger-button" disabled={saving || launching} onClick={() => void onDelete()}><Icon name="trash"/>删除</button>}</div><div>{thread.lane !== "completed" && <button className="secondary-button" disabled={launching} onClick={() => void onPatch({ lane: "completed" })}><Icon name="check"/>标记完成</button>}<button className="primary-button" disabled={saving || launching} onClick={() => void save()}>{saving ? "保存中…" : "保存排布"}</button></div></footer>
  </aside></>;
}

function CreateTaskModal({ initialLane, projectChoices, onClose, onCreated }: { initialLane: "inbox" | "upcoming"; projectChoices: ProjectChoice[]; onClose: () => void; onCreated: () => Promise<void> }) {
  const [title, setTitle] = useState(""); const [note, setNote] = useState(""); const [project, setProject] = useState(""); const [cwd, setCwd] = useState(""); const [lane, setLane] = useState<"inbox" | "upcoming">(initialLane); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent) { event.preventDefault(); if (!title.trim()) return setError("请填写待办名称"); setSaving(true); try { await api("/api/items", { method: "POST", body: JSON.stringify({ title, note, project, cwd, lane }) }); await onCreated(); } catch (reason) { setError(reason instanceof Error ? reason.message : "创建失败"); setSaving(false); } }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="task-modal" onSubmit={submit}><header className="modal-header"><div><span className="modal-icon"><Icon name="plus"/></span><div><h2>挂一个待办</h2><p>先收下来，需要时再交给 Codex</p></div></div><button type="button" className="icon-button" onClick={onClose}><Icon name="close"/></button></header><div className="modal-content"><label className="field field-title"><span>待办名称</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="要处理什么？"/></label><label className="field"><span>说明</span><textarea rows={5} value={note} onChange={(event) => setNote(event.target.value)} placeholder="背景、目标、验收要求…"/></label><div className="field-grid"><ProjectInput id="create-task" value={project} choices={projectChoices} onChange={setProject} onDirectorySuggested={setCwd}/><label className="field"><span>放到</span><select value={lane} onChange={(event) => setLane(event.target.value as typeof lane)}><option value="inbox">收集箱</option><option value="upcoming">待办</option></select></label></div><DirectoryInput id="create-task" value={cwd} project={project} choices={projectChoices} onChange={setCwd} hint="交给 Codex 时必填"/>{error && <p className="form-error">{error}</p>}</div><footer className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? "保存中…" : "加入看板"}</button></footer></form></div>;
}
