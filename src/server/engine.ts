/** Runs the `browser` tool's calls: sessions (one per AI app), their tabs, and each call's steps and output */
import type { CallToolResult, ImageContent, TextContent } from "@modelcontextprotocol/sdk/types.js";

import type { ActionOutcome, AppInfo, BrowserMethod, BrowserMethods, Target } from "../protocol";
import { type CommandDef, COMMANDS, COMMANDS_BY_NAME, browserTool, type StepContext, TIMEOUT_MAX_MS } from "./commands";
import type { BrowserBackend, SessionIO } from "./contracts";
import { MAX_IMAGES, RESPONSE_CAP, StepError, truncate } from "./output";
import { type CommandLine, commandName, ParseError, type ParsedArgs, parseArgs, parseCommands, type Token, tokenize } from "./parser";

const NO_TAB_MESSAGE =
  "There's no current tab. Open one with `goto <url>` or `tab new`, or pick one with `tab list` and `tab select <id>`";
const ECHO_MAX = 200;
/** Room kept for status lines when read output fills the response */
const STATUS_RESERVE = 2000;
const DEFAULT_STEP_MS = 30_000;

export type Session = {
  id: string;
  app: AppInfo;
  io: SessionIO;
  /** The tab commands act on */
  current: number | null;
  /** Tabs the session uses, whoever opened them */
  tabs: Set<number>;
  /** Tabs the session opened, which it may close */
  opened: Set<number>;
  /** Tabs the extension has claimed for this session, until it reconnects */
  claimed: Set<number>;
  /** Console errors seen per tab, to report new ones */
  errorsSeen: Map<number, number>;
};

type CheckedLine = CommandLine & { def: CommandDef; args: ParsedArgs; echo: string };

export type EngineOptions = {
  log?: (...args: unknown[]) => void;
};

export class Engine {
  private readonly sessions = new Map<string, Session>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly log: (...args: unknown[]) => void;

  constructor(private readonly backend: BrowserBackend, options: EngineOptions = {}) {
    this.log = options.log ?? (() => {});
  }

  listTools() {
    return { tools: [browserTool()] };
  }

  addSession(id: string, client: { name: string; title?: string }, io: SessionIO): Session {
    const name = client.title || client.name || "AI app";
    const session: Session = {
      id,
      app: { id: name.toLowerCase().replace(/\W+/g, "-"), name },
      io,
      current: null,
      tabs: new Set(),
      opened: new Set(),
      claimed: new Set(),
      errorsSeen: new Map(),
    };
    this.sessions.set(id, session);
    return session;
  }

  /** The session's app went away: tabs nobody else uses go back to normal, and stay open */
  async removeSession(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    for (const tabId of session.tabs) {
      const usedElsewhere = Array.from(this.sessions.values()).some((other) => other.tabs.has(tabId));
      if (!usedElsewhere && !this.backend.unavailableReason()) {
        await this.backend.call("tabs.release", { tabId }).catch((error) => this.log("release failed", tabId, error));
      }
    }
  }

  /** The browser reconnected, so it has forgotten what it claimed */
  forgetClaims() {
    for (const session of this.sessions.values()) session.claimed.clear();
  }

  async callTool(session: Session, name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    if (name !== "browser") return errorResult(`Unknown tool ${name}`);
    const commands = args?.commands;
    if (typeof commands !== "string") return errorResult('The `browser` tool takes `commands`: a string of command lines');
    const parsed = parseCommands(commands);
    if (!parsed.length) return errorResult("No commands. Run `help`");
    // Everything a line can get wrong without a page is checked first, so a typo at the end runs nothing
    const lines: CheckedLine[] = [];
    for (const line of parsed) {
      const checked = checkLine(line);
      if (typeof checked === "string") {
        const notRun = parsed.length > 1 ? " Nothing ran." : "";
        return errorResult(`${checked}${notRun}`);
      }
      lines.push(checked);
    }
    const release = await this.acquire(`session:${session.id}`);
    try {
      return await this.run(session, lines);
    } finally {
      release();
    }
  }

  private async acquire(key: string): Promise<() => void> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const chained = previous.then(() => mine);
    this.locks.set(key, chained);
    await previous;
    return () => {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    };
  }

  private async run(session: Session, lines: CheckedLine[]): Promise<CallToolResult> {
    if (!lines.every((line) => line.def.noBrowser)) {
      await this.backend.whenReady();
      const unavailable = this.backend.unavailableReason();
      if (unavailable) return errorResult(unavailable);
    }
    const out: string[] = [];
    const images: ImageContent[] = [];
    const start = await this.pageInfo(session);
    let failed = false;
    let budget = RESPONSE_CAP - STATUS_RESERVE;
    const pushPrinted = (printed: string[]) => {
      if (!printed.length) return;
      const text = printed.join("\n");
      if (text.length <= budget) {
        out.push(text);
        budget -= text.length + 1;
        return;
      }
      const hint = `the response is capped at ${RESPONSE_CAP} characters; read less per call`;
      const room = budget - hint.length - 40;
      out.push(room > 200 ? `${text.slice(0, room)}\n… cut at ${room} of ${text.length} characters: ${hint}` : `… ${text.length} characters left out: ${hint}`);
      budget = 0;
    };

    for (const line of lines) {
      const notes: string[] = [];
      const printed: string[] = [];
      try {
        const before = line.def.navigates ? null : await this.pageInfo(session);
        const release = session.current === null ? null : await this.acquire(`tab:${session.current}`);
        try {
          await this.runStep(line, this.stepContext(session, line.args, printed, notes, images));
        } finally {
          release?.();
        }
        if (before) {
          const after = await this.pageInfo(session);
          if (after && before.tabId === after.tabId && before.url !== after.url) {
            notes.push(`→ ${shortUrl(after.url, before.url)}`);
          }
        }
        out.push(`✓ ${line.echo}${notes.length ? ` — ${notes.join("; ")}` : ""}`);
        pushPrinted(printed);
      } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        if (!(error instanceof StepError)) this.log("step failed", line.def.name, message);
        pushPrinted(printed);
        out.push(`✗ step ${line.step}: ${line.echo} — ${message}`);
        out.push(...notRun(line.step, lines.length));
        break;
      }
    }

    const end = await this.pageInfo(session);
    if (end && (failed || !start || start.tabId !== end.tabId || start.url !== end.url || start.title !== end.title)) {
      out.push(`Page: ${end.url} — ${JSON.stringify(truncate(end.title, 200))}`);
    }
    const content: (TextContent | ImageContent)[] = [{ type: "text", text: out.join("\n") }, ...images];
    return { content, ...(failed ? { isError: true } : {}) };
  }

  /** Runs a step, abandoning it when it runs over, so a page that never answers doesn't hold the call */
  private async runStep(line: CheckedLine, ctx: StepContext) {
    const timeout = Math.max(DEFAULT_STEP_MS, line.def.timeoutMs?.(line.args) ?? 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = line.def.run(ctx);
    step.catch(() => {});
    try {
      await Promise.race([
        step,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StepError(`Timed out after ${Math.round(timeout / 100) / 10} s; the step was abandoned`)), timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private stepContext(session: Session, args: ParsedArgs, printed: string[], notes: string[], images: ImageContent[]): StepContext {
    const backend = this.backend;
    const ensureUsable = () => {
      const reason = backend.unavailableReason();
      if (reason) throw new StepError(reason);
    };
    const claimedTab = async (): Promise<number> => {
      const tabId = session.current;
      if (tabId === null) throw new StepError(NO_TAB_MESSAGE);
      ensureUsable();
      if (!session.claimed.has(tabId)) {
        await backend.call("tabs.claim", { tabId, app: session.app });
        session.claimed.add(tabId);
      }
      return tabId;
    };
    const noteOutcome = (result: ActionOutcome) => {
      if (result.stillLoading) notes.push("the page is still loading");
      if (result.navError) notes.push(`the page it opened didn't load: ${result.navError}`);
      for (const opened of result.opened ?? []) {
        session.tabs.add(opened.tabId);
        session.opened.add(opened.tabId);
        session.claimed.add(opened.tabId);
        notes.push(`opened tab ${opened.tabId}${opened.url && opened.url !== "about:blank" ? ` (${opened.url})` : ""}`);
      }
      for (const dialog of result.dialogs ?? []) {
        const label = `${dialog.kind} ${JSON.stringify(truncate(dialog.message, 200))}`;
        notes.push(
          dialog.automatic && dialog.kind !== "alert"
            ? `${label} was dismissed: to accept it, run \`dialog accept\` first and repeat this step`
            : `${label} answered: ${dialog.answer}`,
        );
      }
      if (session.current !== null && result.errorCount !== undefined) {
        const seen = session.errorsSeen.get(session.current) ?? 0;
        const fresh = result.errorCount - seen;
        session.errorsSeen.set(session.current, result.errorCount);
        if (fresh > 0) {
          notes.push(`${fresh} new console error${fresh > 1 ? "s" : ""}: ${truncate(result.lastError ?? "", 120)}`);
        }
      }
    };
    const runOp = async (op: string, target: Target | undefined, opArgs: Record<string, unknown> | undefined, timeoutMs: number | undefined, settle: boolean) => {
      const tabId = await claimedTab();
      const result = await backend.call(
        "page.op",
        {
          tabId,
          op,
          ...(target ? { target } : {}),
          ...(opArgs ? { args: opArgs } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          settle,
        },
        TIMEOUT_MAX_MS,
      );
      noteOutcome(result);
      return result.value;
    };
    return {
      args,
      io: session.io,
      print: (text) => printed.push(text),
      note: (text) => notes.push(text),
      image: (base64, mimeType) => {
        if (images.length < MAX_IMAGES) images.push({ type: "image", data: base64, mimeType });
        else notes.push(`left out: a response holds up to ${MAX_IMAGES} images`);
      },
      tab: claimedTab,
      tabOrNew: async () => {
        if (session.current !== null) return claimedTab();
        ensureUsable();
        return this.createTab(session);
      },
      call: <M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"], timeoutMs?: number) => {
        ensureUsable();
        return backend.call(method, params, timeoutMs);
      },
      act: (op, target, opArgs, timeoutMs) => runOp(op, target, opArgs, timeoutMs, true),
      read: (op, target, opArgs, timeoutMs) => runOp(op, target, opArgs, timeoutMs, false),
      outcome: noteOutcome,
      tabs: {
        list: () => this.listTabs(session),
        create: () => {
          ensureUsable();
          return this.createTab(session);
        },
        select: async (tabId) => {
          ensureUsable();
          await backend.call("tabs.claim", { tabId, app: session.app });
          session.tabs.add(tabId);
          session.claimed.add(tabId);
          session.current = tabId;
        },
        close: async (tabId) => {
          const id = tabId ?? session.current;
          if (id === null) throw new StepError("There's no current tab");
          if (!session.opened.has(id)) {
            throw new StepError(`Tab ${id} isn't one you opened, so it stays open. Switch away with \`tab select <id>\``);
          }
          ensureUsable();
          await backend.call("tabs.close", { tabId: id });
          for (const other of this.sessions.values()) this.forget(other, id);
        },
        show: async (tabId) => {
          const id = tabId ?? session.current;
          if (id === null) throw new StepError(NO_TAB_MESSAGE);
          ensureUsable();
          await backend.call("tabs.activate", { tabId: id });
        },
      },
    };
  }

  private async createTab(session: Session): Promise<number> {
    const { tabId } = await this.backend.call("tabs.create", { app: session.app });
    session.tabs.add(tabId);
    session.opened.add(tabId);
    session.claimed.add(tabId);
    session.current = tabId;
    return tabId;
  }

  private forget(session: Session, tabId: number) {
    session.tabs.delete(tabId);
    session.opened.delete(tabId);
    session.claimed.delete(tabId);
    session.errorsSeen.delete(tabId);
    if (session.current === tabId) session.current = null;
  }

  private async pageInfo(session: Session) {
    const tabId = session.current;
    if (tabId === null || this.backend.unavailableReason()) return null;
    try {
      const { tab } = await this.backend.call("tabs.get", { tabId });
      if (!tab) {
        // The user closed it, or it left the web
        this.forget(session, tabId);
        return null;
      }
      return { tabId, url: tab.url, title: tab.title };
    } catch {
      return null;
    }
  }

  private async listTabs(session: Session): Promise<string> {
    const { tabs } = await this.backend.call("tabs.list", {});
    if (!tabs.length) return "(no tabs)";
    return tabs
      .map((tab) => {
        const marks = [session.tabs.has(tab.tabId) ? "yours" : undefined, tab.active ? "active" : undefined].filter(Boolean);
        const current = tab.tabId === session.current ? "*" : " ";
        return `${current} ${tab.tabId} ${JSON.stringify(truncate(tab.title, 80))} — ${truncate(tab.url, 120)}${marks.length ? ` (${marks.join(", ")})` : ""}`;
      })
      .join("\n");
  }
}

function shortUrl(url: string, previous: string): string {
  try {
    const next = new URL(url);
    if (next.origin === new URL(previous).origin && next.origin !== "null") {
      return next.pathname + next.search + next.hash;
    }
  } catch {
    // Not a URL to shorten
  }
  return url;
}

function checkLine(line: CommandLine): CheckedLine | string {
  const name = commandName(line.source);
  const def = COMMANDS_BY_NAME.get(name);
  let echo = !def || def.echo ? name : truncate(line.source, ECHO_MAX);
  try {
    if (!def) {
      throw new StepError(`Unknown command ${name}. Commands: ${COMMANDS.map((command) => command.name).join(", ")}`);
    }
    const tokens = tokenize(line.source).slice(1);
    if (def.echo) echo = truncate(def.echo(lenientArgs(tokens)), ECHO_MAX);
    const args = parseArgs(name, tokens, def.flags ?? {});
    if (def.echo) echo = truncate(def.echo(args), ECHO_MAX);
    const max = def.maxArgs ?? 0;
    if (args.positional.length > max) {
      throw new StepError(
        `${def.name} takes ${max === 0 ? "no arguments" : `at most ${max} argument${max > 1 ? "s" : ""}`}, got ${args.positional.length}. Quote text with spaces in double quotes; run \`help ${def.name}\``,
      );
    }
    return { ...line, def, args, echo };
  } catch (error) {
    if (error instanceof StepError || error instanceof ParseError) {
      return `✗ step ${line.step}: ${echo} — ${error.message}`;
    }
    throw error;
  }
}

function lenientArgs(tokens: Token[]): ParsedArgs {
  const isFlag = (token: Token) => !token.quoted && token.text.startsWith("-");
  return {
    positional: tokens.filter((token) => !isFlag(token)),
    flags: Object.fromEntries(tokens.filter(isFlag).map((token) => [token.text.replace(/^-+/, ""), true as const])),
  };
}

function notRun(step: number, total: number): string[] {
  if (step >= total) return [];
  return [`${step + 1 === total ? `Step ${total}` : `Steps ${step + 1}–${total}`} not run`];
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
