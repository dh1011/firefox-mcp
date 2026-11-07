import type { BrowserMethod, BrowserMethods, TabInfo } from "../../protocol";
import { Connection, type ConnectionState } from "./connection";
import { navigate, pageCount, pageOp, pageScreenshot, pageSnapshot } from "./page";
import { isExposedUrl } from "./rules";
import {
  addConsoleEntries,
  claim,
  claimed,
  exposedTab,
  release,
  releaseAll,
  sendToFrame,
  startTabTracking,
  stateOf,
  toTabInfo,
} from "./tabs";

declare const __VERSION__: string;

type Handlers = {
  [M in BrowserMethod]: (params: BrowserMethods[M]["params"]) => Promise<BrowserMethods[M]["result"]>;
};

async function newTabWindowId(): Promise<number> {
  try {
    const last = await browser.windows.getLastFocused({ windowTypes: ["normal"] });
    if (last.id !== undefined) return last.id;
  } catch {
    // No window is open
  }
  const created = await browser.windows.create({ focused: false });
  return created.id!;
}

/** The title of a tab in use comes from its page: a tab that was never shown reports its own a good while later */
async function tabInfo(tab: browser.tabs.Tab): Promise<TabInfo> {
  const info = toTabInfo(tab);
  if (!claimed.has(info.tabId)) return info;
  try {
    const reply = await sendToFrame<{ ok?: boolean; value?: string }>(info.tabId, 0, { op: "title" }, 500);
    if (reply.ok && reply.value) info.title = reply.value;
  } catch {
    // Between documents, or busy: what the tab says will do
  }
  return info;
}

const handlers: Handlers = {
  async "tabs.list"() {
    const tabs = await browser.tabs.query({});
    const exposed = await Promise.all(
      tabs.filter((tab) => tab.id !== undefined && !tab.discarded && isExposedUrl(tab.url)).map(tabInfo),
    );
    return { tabs: exposed };
  },
  async "tabs.get"({ tabId }) {
    try {
      const tab = await browser.tabs.get(tabId);
      return { tab: isExposedUrl(tab.url) ? await tabInfo(tab) : null };
    } catch {
      return { tab: null };
    }
  },
  /** Claimed from the start, so its first page has the hooks and its requests are tracked */
  async "tabs.create"({ app }) {
    const windowId = await newTabWindowId();
    const tab = await browser.tabs.create({ url: "about:blank", active: false, windowId });
    await claim(tab.id!, app);
    return { tabId: tab.id! };
  },
  async "tabs.claim"({ tabId, app }) {
    await claim(tabId, app);
    return {};
  },
  async "tabs.release"({ tabId }) {
    await release(tabId);
    return {};
  },
  async "tabs.releaseAll"() {
    await releaseAll();
    return {};
  },
  async "tabs.close"({ tabId }) {
    await exposedTab(tabId);
    await release(tabId);
    await browser.tabs.remove(tabId);
    return {};
  },
  async "tabs.activate"({ tabId }) {
    const tab = await exposedTab(tabId);
    await browser.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined) {
      await browser.windows.update(tab.windowId, { focused: true });
    }
    return {};
  },
  "page.navigate": navigate,
  "page.op": pageOp,
  "page.count": pageCount,
  "page.snapshot": pageSnapshot,
  "page.screenshot": pageScreenshot,
  async "page.console"({ tabId }) {
    return { entries: stateOf(tabId).console };
  },
  async "page.requests"({ tabId }) {
    return {
      entries: stateOf(tabId).requests.map(({ body, requestHeaders, responseHeaders, postData, ...rest }) => rest),
    };
  },
  async "page.request"({ tabId, id }) {
    return { entry: stateOf(tabId).requests.find((entry) => entry.id === id) ?? null };
  },
  async "page.dialogPolicy"({ tabId, accept, text }) {
    const state = stateOf(tabId);
    state.policy = { accept, ...(text !== undefined ? { text } : {}) };
    await broadcastPolicy(tabId, state.policy);
    return {};
  },
};

async function broadcastPolicy(tabId: number, policy: { accept: boolean; text?: string } | null) {
  try {
    await browser.tabs.sendMessage(tabId, { op: "dialogPolicy", args: { policy } });
  } catch {
    // Its pages load the script and ask for the policy (`contentReady`)
  }
}

// --- The popup and the toolbar button ---

const BADGES: Partial<Record<ConnectionState["status"], { text: string; color: string }>> = {
  pending: { text: "!", color: "#c2410c" },
  untrusted: { text: "✕", color: "#b91c1c" },
  outdated: { text: "!", color: "#b91c1c" },
  anotherBrowser: { text: "!", color: "#57534e" },
};

function showBadge(state: ConnectionState) {
  const badge = state.paused && state.status === "connected"
    ? { text: "■", color: "#57534e" }
    : (BADGES[state.status] ?? (claimed.size && state.status === "connected"
        ? { text: String(claimed.size), color: "#0369a1" }
        : { text: "", color: "#000000" }));
  void browser.browserAction.setBadgeText({ text: badge.text });
  void browser.browserAction.setBadgeBackgroundColor({ color: badge.color });
}

async function popupState() {
  const agentTabs = await Promise.all(
    Array.from(claimed.values()).map(async (state) => {
      try {
        const tab = await tabInfo(await browser.tabs.get(state.tabId));
        return { tabId: state.tabId, title: tab.title, app: state.app.name };
      } catch {
        return null;
      }
    }),
  );
  return {
    ...connection.state(),
    version: __VERSION__,
    tabs: agentTabs.filter((tab) => tab !== null),
  };
}

/** Whether the sender is one of this extension's own pages, and not a content script: only those may change pairing */
function isExtensionPage(sender: browser.runtime.MessageSender): boolean {
  const envType = (sender as { envType?: string }).envType;
  return (
    sender.id === browser.runtime.id &&
    !!sender.url?.startsWith(browser.runtime.getURL("")) &&
    envType !== "content_child"
  );
}

async function popupMessage(message: { type: string; port?: number | null; tabId?: number }) {
  switch (message.type) {
    case "getState":
      return popupState();
    case "allow":
      await connection.allow();
      return popupState();
    case "stop":
      await connection.setPaused(true);
      return popupState();
    case "resume":
      await connection.setPaused(false);
      return popupState();
    case "setPort":
      await connection.setCustomPort(message.port ?? null);
      return popupState();
    case "forget":
      await connection.forgetPairings();
      return popupState();
    case "showTab":
      if (message.tabId !== undefined && claimed.has(message.tabId)) {
        await handlers["tabs.activate"]({ tabId: message.tabId });
      }
      return popupState();
    default:
      return undefined;
  }
}

function contentMessage(message: { type: string; [key: string]: unknown }, tabId: number) {
  const state = claimed.get(tabId);
  if (!state) return undefined;
  switch (message.type) {
    case "console":
      addConsoleEntries(state, message.entries as never);
      return undefined;
    case "dialog":
      state.dialogs.push(message.entry as never);
      if (message.consumedPolicy) {
        state.policy = null;
        void broadcastPolicy(tabId, null);
      }
      return undefined;
    case "openTab": {
      const url = String(message.url);
      if (!isExposedUrl(url)) return undefined;
      // `onCreated` makes it the agent's too
      return browser.tabs.create({ url, active: false, openerTabId: tabId }).then(() => undefined);
    }
    case "contentReady":
      return Promise.resolve({ policy: state.policy });
    default:
      return undefined;
  }
}

browser.runtime.onMessage.addListener((raw: unknown, sender) => {
  const message = raw as { type?: string };
  if (typeof message?.type !== "string") return undefined;
  if (isExtensionPage(sender)) return popupMessage(message as never);
  if (sender.id === browser.runtime.id && sender.tab?.id !== undefined) {
    return contentMessage(message as never, sender.tab.id);
  }
  return undefined;
});

// --- Start ---

startTabTracking();

const connection = new Connection(
  { name: "Firefox", version: navigator.userAgent.match(/Firefox\/([\d.]+)/)?.[1] ?? "unknown" },
  __VERSION__,
  async (method, params) => {
    const handler = (Object.hasOwn(handlers, method) ? handlers[method as BrowserMethod] : undefined) as ((params: unknown) => Promise<unknown>) | undefined;
    if (!handler) throw new Error(`Unknown method ${method}: update the extension`);
    const result = await handler(params);
    showBadge(connection.state());
    return result;
  },
  showBadge,
  () => void releaseAll(),
);

void connection.start();
