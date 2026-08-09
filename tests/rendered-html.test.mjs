import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the unchanged Run board and a separate Work Item today workspace", async () => {
  const [html, workspace, todayWorkspace, main, styles, packageJson] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("app/components/TaskWorkspace.tsx", root), "utf8"),
    readFile(new URL("app/components/TodayWorkspace.tsx", root), "utf8"),
    readFile(new URL("src/main.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(html, /Codex Task Monitor/);
  for (const label of ["收集箱", "待办", "进行中", "待 Review", "已完成", "收藏"]) {
    assert.match(workspace, new RegExp(label));
  }
  assert.match(workspace, /new EventSource\("\/api\/events"\)/);
  assert.match(workspace, /\/api\/notifications\/test/);
  assert.match(workspace, /测试 macOS 通知/);
  assert.match(workspace, /completedAt/);
  assert.match(workspace, /thread\.deepLink/);
  assert.match(workspace, /交给 Codex/);
  assert.match(workspace, /thread\.lane === "upcoming"/);
  assert.match(workspace, /thread\.runtimeStatus === "waiting" \? "等待我"/);
  assert.match(workspace, /draggable=\{thread\.runtimeStatus !== "active" && thread\.runtimeStatus !== "waiting"\}/);
  assert.match(workspace, /window\.location\.pathname === "\/completed"/);
  assert.match(workspace, /href="\/completed"/);
  assert.match(workspace, /window\.location\.pathname === "\/favorites"/);
  assert.match(workspace, /href="\/favorites"/);
  assert.match(workspace, /href="\/today"/);
  assert.match(workspace, /className="review-approve"/);
  assert.match(workspace, /onApprove=.*lane: "completed"/);
  assert.match(workspace, /className="completed-page"/);
  assert.match(workspace, /<datalist/);
  assert.match(workspace, /role="combobox"/);
  assert.match(workspace, /className="combobox-options"/);
  assert.match(workspace, /没有匹配项目，可直接输入新项目/);
  assert.match(workspace, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(workspace, /role="option"[^>]+onMouseDown=\{\(event\) => event\.preventDefault\(\)\}[^>]+onClick=/);
  assert.match(workspace, /onDirectorySuggested/);
  assert.match(workspace, /async function save\(\)[\s\S]+await onPatch\(changes\(\)\);[\s\S]+onClose\(\);[\s\S]+catch/);
  assert.doesNotMatch(workspace, /修改对话名称|onRename|unread-badge|read: true/);
  assert.match(workspace, /thread\.kind === "manual" && <label className="field"><span>待办名称<\/span>/);
  assert.match(workspace, /选择已有目录或输入绝对路径/);
  assert.doesNotMatch(workspace, /近期处理/);
  assert.match(workspace, /\/api\/items\/\$\{id\}\/start/);
  assert.doesNotMatch(workspace, /新增任务|createTask/);
  assert.match(styles, /\.board-column,.card-list,.task-card\s*\{\s*min-width:0/);
  assert.match(styles, /\.task-card h3,.task-description[^}]+overflow-wrap:anywhere/);
  assert.match(styles, /\.card-list[^}]+overflow-y:auto/);
  assert.match(styles, /\.card-list>\.task-card[^}]+flex:0 0 auto/);
  assert.match(styles, /\.completed-grid[^}]+overflow-y:auto/);
  assert.match(styles, /\.completed-grid[^}]+grid-auto-rows:max-content/);
  assert.match(styles, /\.task-modal\s*\{[^}]+overflow:visible/);
  assert.match(styles, /\.combobox-options::\-webkit-scrollbar\s*\{\s*display:none/);
  assert.match(styles, /@media\(max-height:760px\)[\s\S]+\.combobox-options\s*\{[^}]+bottom:100%/);
  assert.match(styles, /@media\(max-width:900px\)[\s\S]+\.card-list,.completed-grid\s*\{\s*overflow:visible/);
  assert.match(main, /window\.location\.pathname === "\/today"/);
  for (const label of ["今日主线", "后台执行", "等待决定", "待验收", "停车场"]) assert.match(todayWorkspace, new RegExp(label));
  assert.match(todayWorkspace, /\/api\/work-items/);
  assert.match(todayWorkspace, /expectedVersion: item\.version, todayFocus/);
  assert.match(todayWorkspace, /\["ready", "active", "blocked"\]\.includes\(item\.status\)/);
  assert.match(todayWorkspace, /由你选择，Codex 不会自动改变计划/);
  assert.doesNotMatch(todayWorkspace, /\/api\/threads/);
  assert.match(styles, /\.today-board/);
  assert.doesNotMatch(`${html}\n${packageJson}`, /codex-preview|vinext|wrangler|react-loading-skeleton/i);
});
