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

export type WorkItemRun = {
  id: string;
  workItemId: string;
  status: "queued" | "running" | "waiting" | "completed" | "interrupted" | "failed" | "canceled";
  objective: string;
  codexThreadId: string | null;
  codexTurnId: string | null;
  mode: "explore" | "implementation";
  expectedOutput: string;
  contextWorkItemVersion: number | null;
  launchState: string;
  launchError: string | null;
  terminalAt: string | null;
  terminalError: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type DecisionRequest = {
  id: string;
  workItemId: string;
  runId: string;
  question: string;
  contextSummary: string;
  options: { id: string; label: string; description: string }[];
  recommendedOptionId: string | null;
  recommendationReason: string;
  risks: string;
  defaultConsequence: string;
  status: "pending" | "answered" | "canceled";
  routingState: "not_requested" | "routing" | "routed" | "failed" | "uncertain";
  routingError: string | null;
  sourceUri: string;
  answerOptionId: string | null;
  answerText: string | null;
  answerUri: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ReviewSubmission = {
  id: string;
  workItemId: string;
  runId: string;
  workItemVersion: number;
  completedSummary: string;
  verificationSummary: string;
  risks: string;
  needsDecision: string;
  suggestedNextAction: string;
  sourceUri: string;
  version: number;
  createdAt: string;
};

export type ReviewAction = {
  id: string;
  reviewSubmissionId: string;
  action: "approve" | "request_changes" | "accept_with_follow_up";
  state: "applying" | "applied" | "failed" | "uncertain";
  feedback: string;
  revisionRunId: string | null;
  followUpWorkItemId: string | null;
  error: string | null;
  version: number;
  createdAt: string;
};

type Attributed = { version: number; actorType: string; actorId: string; codexThreadId: string | null; createdAt: string };
export type WorkItemContext = {
  decisions: ({ id: string; workItemId: string; decision: string; reason: string } & Attributed)[];
  recoveryPoints: ({ id: string; workItemId: string; sourceRunId: string | null; workItemVersion: number; currentGoal: string; currentConclusion: string; completed: string[]; unresolved: string[]; nextAction: string; resourceRefs: string[] } & Attributed)[];
  relations: ({ id: string; workItemId: string; targetWorkItemId: string; relationType: "parent" | "blocked_by" | "related" } & Attributed)[];
  evidence: ({ id: string; workItemId: string; runId: string | null; kind: string; label: string; uri: string; summary: string } & Attributed)[];
};

export type WorkItemDetail = {
  workItem: WorkItem;
  runs: WorkItemRun[];
  context: WorkItemContext;
  decisionRequests: DecisionRequest[];
  reviews: ReviewSubmission[];
  reviewActions: ReviewAction[];
};

export type WipPolicy = {
  id: "default";
  mainlineLimit: number;
  backgroundRunLimit: number;
  reviewLimit: number;
  enforcement: "warn" | "block";
  version: number;
  updatedAt: string;
};

export type WipLaneSnapshot = { count: number; limit: number; atLimit: boolean; exceeded: boolean };
export type WipSnapshot = {
  counts: { mainline: number; backgroundRuns: number; review: number };
  lanes: { mainline: WipLaneSnapshot; backgroundRuns: WipLaneSnapshot; review: WipLaneSnapshot };
};

export type BoardManagerInboxItem = {
  id: string;
  version: number;
  title: string;
  summary: string;
  goal: string;
  nextAction: string;
  project: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type BoardManagerCall = {
  id: string;
  action: "inbox_organize";
  status: "queued" | "running" | "completed" | "failed" | "uncertain";
  input: { action: "inbox_organize"; generatedAt: string; inboxItems: BoardManagerInboxItem[] };
  inputItemCount: number;
  summary: string;
  codexThreadId: string | null;
  codexTurnId: string | null;
  sourceUri: string | null;
  error: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type BoardManagerSuggestion = {
  id: string;
  callId: string;
  kind: "update_work_item" | "duplicate_candidate";
  workItemId: string;
  relatedWorkItemId: string | null;
  expectedWorkItemVersion: number;
  title: string;
  reason: string;
  impact: string;
  patch: Partial<Pick<WorkItem, "title" | "description" | "goal" | "nextAction" | "project" | "tags" | "status" | "stage">>;
  state: "pending" | "applied";
  appliedAt: string | null;
  createdAt: string;
};

export type BoardManagerResult = { call: BoardManagerCall; suggestions: BoardManagerSuggestion[]; replayed?: boolean };

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
  workItemId?: string | null;
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
