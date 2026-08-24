import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { RoundtableAuthor, RoundtableEvidence, RoundtableMessage, RoundtableTopic } from "../types";

type TopicDetail = { topic: RoundtableTopic; messages: RoundtableMessage[]; evidence: RoundtableEvidence[] };

const AUTHORS: Record<string, { name: string; short: string }> = {
  user: { name: "我", short: "我" }, moderator: { name: "主持人", short: "主" }, codex: { name: "Codex", short: "C" },
  cursor: { name: "Cursor", short: "Cu" }, minimax: { name: "MiniMax", short: "M" },
  我: { name: "我", short: "我" }, 主持人: { name: "主持人", short: "主" }, Codex: { name: "Codex", short: "C" },
  Cursor: { name: "Cursor", short: "Cu" }, MiniMax: { name: "MiniMax", short: "M" },
};
const STATUS_LABEL: Record<string, string> = { idle: "准备中", running: "讨论中", completed: "已完成", cancelled: "已停止", failed: "失败" };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body as T;
}

function authorInfo(author: RoundtableAuthor) {
  return AUTHORS[author] || { name: author || "Agent", short: (author || "A").slice(0, 2).toUpperCase() };
}

function authorKey(author: RoundtableAuthor) {
  return ({ 我: "user", 主持人: "moderator", Codex: "codex", Cursor: "cursor", MiniMax: "minimax" } as Record<string, string>)[author] || author;
}

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export default function RoundtableWorkspace() {
  const [topics, setTopics] = useState<RoundtableTopic[]>([]);
  const [selectedId, setSelectedId] = useState(() => new URLSearchParams(window.location.search).get("topic") || "");
  const [detail, setDetail] = useState<TopicDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [message, setMessage] = useState("");
  const [target, setTarget] = useState("all");
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const conversationRef = useRef<HTMLElement>(null);

  const loadTopics = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await api<{ topics: RoundtableTopic[] }>("/api/roundtable/topics");
      setTopics(result.topics || []);
      setSelectedId((current) => current || result.topics?.[0]?.id || "");
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取圆桌议题"); }
    finally { if (!quiet) setLoading(false); }
  }, []);

  const loadDetail = useCallback(async (id: string, quiet = false) => {
    if (!id) { setDetail(null); return; }
    if (!quiet) setDetailLoading(true);
    try {
      const result = await api<TopicDetail>(`/api/roundtable/topics/${encodeURIComponent(id)}`);
      setDetail(result);
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取讨论内容"); }
    finally { if (!quiet) setDetailLoading(false); }
  }, []);

  useEffect(() => { void loadTopics(); }, [loadTopics]);
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    const url = new URL(window.location.href); url.searchParams.set("topic", selectedId); window.history.replaceState(null, "", url);
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);
  useEffect(() => {
    const events = new EventSource("/api/roundtable/events");
    const changed = (event: Event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data || "{}");
        void loadTopics(true);
        if (!payload.topicId || payload.topicId === selectedId) void loadDetail(selectedId, true);
      } catch { /* ignore malformed local SSE events */ }
    };
    events.addEventListener("roundtable-changed", changed);
    return () => events.close();
  }, [loadTopics, loadDetail, selectedId]);
  useEffect(() => {
    const syncFullscreenState = () => setIsFullscreen(document.fullscreenElement === conversationRef.current);
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  const filteredTopics = useMemo(() => topics.filter((topic) => !query.trim() || [topic.title, topic.prompt, topic.cwd].join(" ").toLowerCase().includes(query.trim().toLowerCase())), [topics, query]);

  async function createTopic(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !prompt.trim() || !cwd.trim()) { setError("请填写议题名称、项目目录和讨论问题"); return; }
    setCreating(true);
    try {
      const result = await api<{ topic: RoundtableTopic }>("/api/roundtable/topics", { method: "POST", body: JSON.stringify({ title: title.trim(), prompt: prompt.trim(), cwd: cwd.trim() }) });
      setTitle(""); setPrompt(""); setCwd(""); setShowCreate(false); setSelectedId(result.topic.id);
      await loadTopics(true); await loadDetail(result.topic.id, true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法创建讨论"); }
    finally { setCreating(false); }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!selectedId || !message.trim()) return;
    setSending(true);
    try {
      await api(`/api/roundtable/topics/${encodeURIComponent(selectedId)}/messages`, { method: "POST", body: JSON.stringify({ content: message.trim(), ...(target === "all" ? {} : { target }) }) });
      setMessage(""); await loadDetail(selectedId, true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "发言失败"); }
    finally { setSending(false); }
  }

  async function cancelTopic() {
    if (!selectedId) return;
    setCancelling(true);
    try {
      await api(`/api/roundtable/topics/${encodeURIComponent(selectedId)}/cancel`, { method: "POST", body: "{}" });
      await Promise.all([loadTopics(true), loadDetail(selectedId, true)]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "停止讨论失败"); }
    finally { setCancelling(false); }
  }

  async function retryTopic() {
    if (!selectedId) return;
    setRetrying(true);
    try {
      await api(`/api/roundtable/topics/${encodeURIComponent(selectedId)}/retry`, { method: "POST", body: "{}" });
      await Promise.all([loadTopics(true), loadDetail(selectedId, true)]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "重试讨论失败"); }
    finally { setRetrying(false); }
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === conversationRef.current) await document.exitFullscreen();
      else await conversationRef.current?.requestFullscreen();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法切换全屏模式"); }
  }

  return <main className="workspace-shell roundtable-shell">
    <header className="topbar">
      <div className="brand-area"><div className="brand"><span className="brand-mark"><img src="/app-icon-192.png" alt=""/></span><div><strong>Codex Task Monitor</strong><span>本地任务盘点</span></div></div></div>
      <label className="search-box"><span aria-hidden>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索圆桌议题、问题或路径"/></label>
      <div className="top-actions"><button className="icon-button" onClick={() => void Promise.all([loadTopics(), selectedId ? loadDetail(selectedId) : Promise.resolve()])} title="刷新圆桌">↻</button></div>
    </header>
    <section className="page-heading roundtable-heading">
      <nav className="page-tabs" aria-label="任务页面"><a href="/">任务看板</a><a href="/completed">已完成</a><a href="/favorites">收藏</a><a className="active" href="/roundtable">圆桌讨论</a></nav>
      <div className="roundtable-heading-copy"><strong>多 Agent 圆桌</strong><span>独立研究、交叉质询、保留分歧</span></div>
      <button className="manager-action" onClick={() => setShowCreate(true)}>＋ 新建议题</button>
    </section>
    {error && <div className="error-banner">{error}<button onClick={() => setError("")}>关闭</button></div>}
    <section className="roundtable-layout">
      <aside className="roundtable-panel topic-panel" aria-label="圆桌议题">
        <div className="roundtable-panel-title"><strong>历史议题</strong><span>{filteredTopics.length}</span></div>
        <div className="topic-list">{loading ? <p className="roundtable-empty">正在读取…</p> : filteredTopics.length ? filteredTopics.map((topic) => <button className={`topic-item${topic.id === selectedId ? " active" : ""}`} key={topic.id} onClick={() => setSelectedId(topic.id)}><span className={`topic-status status-${topic.status}`}>{STATUS_LABEL[topic.status] || topic.status}</span><strong>{topic.title}</strong><small>{topic.cwd || "未指定项目目录"}</small><time>{displayTime(topic.updatedAt)}</time></button>) : <p className="roundtable-empty">还没有讨论，创建一个议题开始。</p>}</div>
      </aside>
      <section className="roundtable-panel conversation-panel" ref={conversationRef}>
        {!detail || detailLoading ? <div className="conversation-placeholder"><span>◌</span><strong>{detailLoading ? "正在加载讨论…" : "选择或创建一个议题"}</strong><p>Codex、Cursor 和 MiniMax 会先独立研究，再进行交叉质询。</p></div> : <>
          <header className="conversation-header"><div><span className={`topic-status status-${detail.topic.status}`}>{STATUS_LABEL[detail.topic.status] || detail.topic.status}</span><h1>{detail.topic.title}</h1><p>{detail.topic.cwd || "未指定项目目录"}</p></div><div className="conversation-actions">{["failed", "cancelled"].includes(detail.topic.status) && <button className="retry-button" disabled={retrying} onClick={() => void retryTopic()}>{retrying ? "重试中…" : "重试讨论"}</button>}{detail.topic.status === "running" && <button className="stop-button" disabled={cancelling} onClick={() => void cancelTopic()}>{cancelling ? "停止中…" : "停止讨论"}</button>}<button className="fullscreen-button" type="button" onClick={() => void toggleFullscreen()} aria-label={isFullscreen ? "退出全屏" : "全屏阅读"} aria-pressed={isFullscreen} title={isFullscreen ? "退出全屏（Esc）" : "全屏阅读"}><svg viewBox="0 0 24 24" aria-hidden><path d={isFullscreen ? "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" : "M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"}/></svg></button></div></header>
          <div className="message-list" aria-live="polite">{detail.messages?.length ? detail.messages.map((item) => <MessageBubble message={item} key={item.id}/>) : <div className="roundtable-empty">等待第一位 Agent 发言…</div>}</div>
          <form className="message-composer" onSubmit={sendMessage}><select value={target} onChange={(event) => setTarget(event.target.value)} aria-label="发言对象"><option value="all">@所有 Agent</option><option value="codex">@Codex</option><option value="cursor">@Cursor</option><option value="minimax">@MiniMax</option><option value="moderator">@主持人</option></select><textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={2} placeholder={target === "moderator" ? "例如：先总结当前分歧和下一步…" : "继续追问、补充约束，或要求挑战当前结论…"}/><button className="primary-button" disabled={sending || !message.trim()}>{sending ? "发送中…" : "发送"}</button></form>
        </>}
      </section>
      <aside className="roundtable-panel evidence-panel" aria-label="证据资料">
        <div className="roundtable-panel-title"><strong>证据与资料</strong><span>{detail?.evidence?.length || 0}</span></div>
        <div className="evidence-list">{detail?.evidence?.length ? detail.evidence.map((item) => <EvidenceCard evidence={item} key={item.id}/>) : <p className="roundtable-empty">代码位置、网页、论文和实验结果会集中显示在这里。</p>}</div>
      </aside>
    </section>
    {showCreate && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCreate(false); }}><form className="task-modal roundtable-create" onSubmit={createTopic}><header className="modal-header"><div><span className="modal-icon">◉</span><div><h2>发起圆桌讨论</h2><p>三个 Agent 独立调查，再交换观点和证据</p></div></div><button type="button" className="icon-button" onClick={() => setShowCreate(false)}>×</button></header><div className="modal-content"><label className="field field-title"><span>议题名称</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：智能审批 Agent 架构重构"/></label><label className="field"><span>项目目录 <em>必填，填写存在的绝对路径</em></span><input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/Users/name/Developer/project"/></label><label className="field"><span>希望大家讨论什么</span><textarea rows={7} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="说明现状、问题、约束，以及希望重点调查的方向…"/></label></div><footer className="modal-actions"><button type="button" className="secondary-button" onClick={() => setShowCreate(false)}>取消</button><button className="primary-button" disabled={creating}>{creating ? "启动中…" : "开始讨论"}</button></footer></form></div>}
  </main>;
}

function MessageBubble({ message }: { message: RoundtableMessage }) {
  const author = authorInfo(message.author);
  const phase = message.metadata?.phase || message.kind;
  return <article className={`roundtable-message author-${authorKey(message.author)}`}><span className="agent-avatar">{author.short}</span><div><header><strong>{author.name}</strong>{phase && !["question", "status"].includes(phase) && <span>{phase}</span>}<time>{displayTime(message.createdAt)}</time>{message.kind === "status" && <i>状态</i>}</header><div className="message-markdown"><Markdown remarkPlugins={[remarkGfm]} components={{
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer"/>,
    img: ({ node: _node, src, alt }) => src ? <a href={src} target="_blank" rel="noreferrer">{alt || "查看图片"}</a> : null,
  }}>{message.content || "等待输出…"}</Markdown></div></div></article>;
}

function EvidenceCard({ evidence }: { evidence: RoundtableEvidence }) {
  const web = evidence.type === "web" && /^https?:\/\//.test(evidence.value);
  return <article className="evidence-card"><header><span>{evidence.type || "资料"}</span></header>{web ? <a href={evidence.value} target="_blank" rel="noreferrer">{evidence.label || evidence.value}</a> : <strong>{evidence.label || "代码证据"}</strong>}{!web && <code>{evidence.value}</code>}</article>;
}
