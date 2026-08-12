export type TaskLane = "inbox" | "upcoming" | "in_progress" | "review" | "completed";
export type RuntimeStatus = "unknown" | "idle" | "active" | "waiting" | "interrupted";
export type Priority = "low" | "medium" | "high";

export type CodexQuotaWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: string | null;
};

export type CodexQuota = {
  available: boolean;
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  primary: CodexQuotaWindow | null;
  secondary: CodexQuotaWindow | null;
  fetchedAt: string;
};

export type AttentionAdvice = {
  attentionToken: string;
  headline: string;
  focus: string;
  background: string;
  after: string;
  parked: string;
  nextCheck: string;
  risk: string;
  primaryTaskId: string | null;
  generatedAt: string;
};

export type RoundtableStatus = "idle" | "running" | "completed" | "cancelled" | "failed";
export type RoundtableAuthor = "user" | "moderator" | "codex" | "cursor" | "minimax" | string;

export type RoundtableTopic = {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  status: RoundtableStatus;
  phase?: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
  error?: string;
};

export type RoundtableMessage = {
  id: string;
  topicId: string;
  author: RoundtableAuthor;
  content: string;
  role?: "user" | "agent" | "moderator" | string;
  kind?: "question" | "status" | "analysis" | "critique" | "summary" | "error" | string;
  metadata?: { agent?: string; phase?: string; model?: string; target?: string | null; [key: string]: unknown };
  createdAt: string;
  error?: string;
};

export type RoundtableEvidence = {
  id: string;
  topicId: string;
  messageId?: string;
  type: "web" | "code" | string;
  value: string;
  label?: string;
  createdAt?: string;
};

export type CodexThread = {
  kind: "manual" | "codex";
  id: string;
  title: string;
  preview: string;
  cwd: string;
  project: string;
  source: "manual" | "vscode" | "cli";
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  pinned: boolean;
  deepLink: string | null;
  codexThreadId?: string | null;
  launchRequestedAt?: string | null;
  runtimeStatus: RuntimeStatus;
  activeTurnId: string | null;
  activeStartedAt: string | null;
  lastCompletedAt: string | null;
  lastInterruptedAt?: string | null;
  lastProgress: string;
  lastProgressAt: string | null;
  lastFileChangeAt: string | null;
  lastError: string;
  lane: TaskLane;
  tags: string[];
  priority: Priority;
  sortOrder: number;
  hidden: boolean;
  note: string;
  completedAt: string | null;
};
