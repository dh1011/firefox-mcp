import type { ConnectionState } from "./background/connection";

type PopupState = ConnectionState & {
  version: string;
  tabs: { tabId: number; title: string; app: string }[];
};

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const STATUS_TEXT: Record<ConnectionState["status"], string> = {
  searching: "Waiting for an AI app. It connects when one first uses the browser.",
  connecting: "Connecting…",
  pending: "Waiting for your approval.",
  connected: "Connected",
  untrusted: "",
  anotherBrowser: "Another Firefox window or profile is connected to the server. Close that one to use this one.",
  outdated: "",
};

async function send(message: Record<string, unknown>) {
  const state = (await browser.runtime.sendMessage(message)) as PopupState;
  render(state);
}

let portEdited = false;

function render(state: PopupState) {
  const connected = state.status === "connected";
  const status = byId("status");
  status.textContent = connected && state.paused
    ? "Stopped: agents can't use this browser until you press Resume."
    : state.detail || STATUS_TEXT[state.status];

  const dot = byId("dot");
  dot.dataset.tone = connected && !state.paused ? "ok" : state.status === "searching" ? "" : "warn";

  byId("pairing").hidden = state.status !== "pending";
  byId("code").textContent = state.code ? `Code: ${state.code}` : "";

  byId("control").hidden = !connected;
  byId("stop").hidden = state.paused;
  byId("resume").hidden = !state.paused;

  byId("tabs-section").hidden = state.tabs.length === 0;
  const list = byId("tabs");
  list.replaceChildren(
    ...state.tabs.map((tab) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = tab.title || "New tab";
      const app = document.createElement("span");
      app.className = "tab-app";
      app.textContent = tab.app;
      button.append(title, app);
      button.title = "Show this tab";
      button.addEventListener("click", () => void send({ type: "showTab", tabId: tab.tabId }));
      item.append(button);
      return item;
    }),
  );

  const port = byId<HTMLInputElement>("port");
  if (!portEdited) port.value = state.customPort ? String(state.customPort) : "";
  byId("version").textContent = `Version ${state.version}`;
}

byId("allow").addEventListener("click", () => void send({ type: "allow" }));
byId("stop").addEventListener("click", () => void send({ type: "stop" }));
byId("resume").addEventListener("click", () => void send({ type: "resume" }));
byId("forget").addEventListener("click", () => void send({ type: "forget" }));
byId("port").addEventListener("input", () => {
  portEdited = true;
});
byId("save-port").addEventListener("click", () => {
  const value = byId<HTMLInputElement>("port").value.trim();
  portEdited = false;
  void send({ type: "setPort", port: value ? Number(value) : null });
});

void send({ type: "getState" });
setInterval(() => void send({ type: "getState" }), 500);
