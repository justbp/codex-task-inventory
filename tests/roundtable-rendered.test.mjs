import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships a separate roundtable workspace inside the existing board", async () => {
  const [main, board, roundtable, styles, types] = await Promise.all([
    readFile(new URL("src/main.tsx", root), "utf8"),
    readFile(new URL("app/components/TaskWorkspace.tsx", root), "utf8"),
    readFile(new URL("app/components/RoundtableWorkspace.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("app/types.ts", root), "utf8"),
  ]);

  assert.match(main, /window\.location\.pathname === "\/roundtable"/);
  assert.match(board, /href="\/roundtable">圆桌讨论/);
  assert.match(roundtable, /className="roundtable-layout"/);
  assert.match(roundtable, /react-markdown/);
  assert.match(roundtable, /remark-gfm/);
  assert.match(roundtable, /className="message-markdown"/);
  assert.match(roundtable, /历史议题/);
  assert.match(roundtable, /证据与资料/);
  assert.match(roundtable, /新建议题/);
  assert.match(roundtable, /继续追问、补充约束/);
  assert.match(roundtable, /@主持人/);
  assert.match(roundtable, /先总结当前分歧和下一步/);
  assert.match(roundtable, /停止讨论/);
  assert.match(roundtable, /重试讨论/);
  assert.match(roundtable, /new EventSource\("\/api\/roundtable\/events"\)/);
  assert.match(roundtable, /addEventListener\("roundtable-changed"/);
  assert.match(roundtable, /POST/);
  assert.match(roundtable, /\/api\/roundtable\/topics/);
  assert.match(roundtable, /\/messages/);
  assert.match(roundtable, /\/cancel/);
  assert.match(roundtable, /\/retry/);
  assert.match(roundtable, /aria-live="polite"/);
  assert.match(styles, /\.roundtable-layout\s*\{/);
  assert.match(styles, /\.message-markdown h1/);
  assert.match(styles, /\.message-markdown table/);
  assert.match(styles, /\.message-markdown pre/);
  assert.match(styles, /grid-template-columns:250px minmax\(420px,1fr\) 300px/);
  assert.match(styles, /@media\(max-width:900px\)[\s\S]+\.roundtable-layout/);
  assert.match(types, /export type RoundtableTopic/);
  assert.match(types, /export type RoundtableMessage/);
  assert.match(types, /export type RoundtableEvidence/);
});
