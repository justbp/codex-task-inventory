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
