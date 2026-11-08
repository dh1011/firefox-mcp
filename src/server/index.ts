#!/usr/bin/env node
import { isValidRelayPort } from "../protocol";
import { runThin } from "./thin";
import { VERSION } from "./version";

const USAGE = `firefox-mcp: an MCP server that lets AI agents use your Firefox, through the MCP for Firefox extension.

Usage: firefox-mcp [--port <port>]

  --port <port>  Use the daemon on this port only (set the same port in the extension's settings)
  --version      Print the version
  --help         Print this

An AI app runs this over stdio. Add it to the app's MCP config:
  { "mcpServers": { "firefox": { "command": "node", "args": ["/path/to/firefox-mcp/dist/server/index.js"] } } }`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (args.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}
const portFlag = args.indexOf("--port");
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : undefined;
const known = portFlag >= 0 ? args.length === 2 : args.length === 0;
if (!known || (port !== undefined && !isValidRelayPort(port))) {
  console.error(USAGE);
  process.exit(1);
}

void runThin(port !== undefined ? { port } : {});
