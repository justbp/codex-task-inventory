import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import TaskWorkspace from "../app/components/TaskWorkspace";
import RoundtableWorkspace from "../app/components/RoundtableWorkspace";
import "../app/globals.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("未找到应用挂载节点 #root");
}

createRoot(root).render(
  <StrictMode>
    {window.location.pathname === "/roundtable" ? <RoundtableWorkspace /> : <TaskWorkspace />}
  </StrictMode>,
);
