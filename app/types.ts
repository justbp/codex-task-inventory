export type TaskLane = "inbox" | "upcoming" | "in_progress" | "review" | "completed";
export type RuntimeStatus = "unknown" | "idle" | "active" | "waiting" | "interrupted";
export type Priority = "low" | "medium" | "high";
export type WorkStatus = "inbox" | "ready" | "active" | "awaiting_decision" | "in_review" | "blocked" | "parked" | "done" | "canceled";
export type WorkStage = "explore" | "experiment" | "execute" | "verify";

export type WorkItem = {
  id: string;
  title: string;
  description: string;
  goal: string;
  nextAction: string;
  acceptanceCriteria: string[];
  scope: { allowed: string; excluded: string };
  stopConditions: string[];
  constraints: string[];
  status: WorkStatus;
  stage: WorkStage;
  project: string | null;
  cwd: string | null;
  tags: string[];
  priority: Priority;
  sortOrder: number;
  pinned: boolean;
  todayFocus: boolean;
  hidden: boolean;
  source: { kind: "manual" | "codex"; id: string } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

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
