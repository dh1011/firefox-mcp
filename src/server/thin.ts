/** The process each AI app runs: MCP over stdio, forwarding to the daemon */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { PRODUCT_NAME } from "../protocol";
import { INSTRUCTIONS } from "./commands";
import type { DaemonToClientMethods } from "./contracts";
import { DaemonClient } from "./daemon-client";
import { mcpHome } from "./paths";
import { errorMessage, type RpcHandlers } from "./rpc";
import { VERSION } from "./version";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
};

/**
 * For `upload` and `screenshot --path`. Any path works, as for the commands an agent runs with the user's permissions:
 * `~` is the home directory, and relative paths resolve against the AI app's first MCP root
 */
export function createFileAccess(roots: () => Promise<string[]>, home = homedir()): RpcHandlers<DaemonToClientMethods> {
  async function resolveFile(file: string): Promise<string> {
    if (file === "~" || file.startsWith("~/") || file.startsWith("~\\")) return path.join(home, file.slice(1));
    if (path.isAbsolute(file)) return path.normalize(file);
    const [base = process.cwd()] = await roots();
    return path.resolve(base, file);
  }
  return {
    async readFile({ path: file }) {
      const absolute = await resolveFile(file);
      const data = await readFile(absolute);
      return {
        name: path.basename(absolute),
        mimeType: MIME_TYPES[path.extname(absolute).toLowerCase()] ?? "application/octet-stream",
        base64: data.toString("base64"),
      };
    },
    async writeFile({ path: file, base64 }) {
      const absolute = await resolveFile(file);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, Buffer.from(base64, "base64"));
      return { path: absolute };
    },
  };
}

export type ThinOptions = { port?: number };

export async function runThin(options: ThinOptions) {
  const log = process.env.FIREFOX_MCP_DEBUG
    ? (...args: unknown[]) => console.error("[firefox-mcp]", ...args)
    : () => {};
  const server = new Server(
    { name: PRODUCT_NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  const roots = async (): Promise<string[]> => {
    if (server.getClientCapabilities()?.roots) {
      try {
        const listed = await server.listRoots(undefined, { timeout: 5000 });
        const paths = listed.roots.filter((root) => root.uri.startsWith("file://")).map((root) => fileURLToPath(root.uri));
        if (paths.length) return paths;
      } catch (error) {
        log("Couldn't list the MCP roots:", errorMessage(error));
      }
    }
    return [process.cwd()];
  };

  const daemon = new DaemonClient({
    home: mcpHome(),
    ...(options.port ? { port: options.port } : {}),
    version: VERSION,
    daemonCommand: [process.execPath, fileURLToPath(new URL("./daemon.js", import.meta.url))],
    client: () => {
      const client = server.getClientVersion();
      return {
        name: client?.name ?? "MCP client",
        ...(client?.title ? { title: client.title } : {}),
        ...(client?.version ? { version: client.version } : {}),
      };
    },
    files: createFileAccess(roots),
    log,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await daemon.call("tools/list", {});
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    try {
      return await daemon.call("tools/call", {
        name: request.params.name,
        ...(request.params.arguments ? { arguments: request.params.arguments } : {}),
      });
    } catch (error) {
      const message = errorMessage(error);
      return {
        content: [
          {
            type: "text",
            text:
              message === "Connection closed"
                ? "The MCP for Firefox daemon stopped while handling this call. Run it again: a new daemon starts, and the browser reconnects within seconds"
                : message,
          },
        ],
        isError: true,
      };
    }
  });

  process.stdin.on("close", () => {
    daemon.close();
    void server.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
  await server.connect(new StdioServerTransport());
}
