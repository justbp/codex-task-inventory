import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the four-stage board and a separate completed page", async () => {
  const [html, workspace, styles, packageJson] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("app/components/TaskWorkspace.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(html, /Codex Task Monitor/);
  for (const label of ["收集箱", "待办", "进行中", "待 Review", "已完成"]) {
    assert.match(workspace, new RegExp(label));
  }
  assert.match(workspace, /new EventSource\("\/api\/events"\)/);
  assert.match(workspace, /completedAt/);
  assert.match(workspace, /thread\.deepLink/);
  assert.match(workspace, /交给 Codex/);
  assert.match(workspace, /thread\.lane === "upcoming"/);
  assert.match(workspace, /window\.location\.pathname === "\/completed"/);
  assert.match(workspace, /href="\/completed"/);
  assert.match(workspace, /className="completed-page"/);
  assert.match(workspace, /<datalist/);
  assert.match(workspace, /onDirectorySuggested/);
  assert.match(workspace, /选择已有目录或输入绝对路径/);
  assert.doesNotMatch(workspace, /近期处理/);
  assert.match(workspace, /\/api\/items\/\$\{id\}\/start/);
  assert.doesNotMatch(workspace, /新增任务|createTask/);
  assert.match(styles, /\.board-column,.card-list,.task-card\s*\{\s*min-width:0/);
  assert.match(styles, /\.task-card h3,.task-description[^}]+overflow-wrap:anywhere/);
  assert.doesNotMatch(`${html}\n${packageJson}`, /codex-preview|vinext|wrangler|react-loading-skeleton/i);
});
