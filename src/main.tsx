import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import SessionsApp from "./sessions/SessionsApp";
import "./styles.css";

let windowLabel = "main";
try {
  windowLabel = getCurrentWindow().label;
} catch {
  // 非 Tauri 环境（纯浏览器 dev）退回主界面
}

const Root = windowLabel === "sessions" ? SessionsApp : App;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
