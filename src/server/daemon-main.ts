/** The daemon's process, started detached by the first thin process. A lock file keeps it to one per user and port */
import { appendFileSync, closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";

import { isValidRelayPort } from "../protocol";
import { Daemon } from "./daemon";
import { daemonInfoPath, daemonLockPath, daemonLogPath, ensureHome, fetchStatus, mcpHome, readDaemonInfo } from "./paths";
import { VERSION } from "./version";

const home = mcpHome();
ensureHome(home);

const portFlag = process.argv.indexOf("--port");
const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : undefined;
if (port !== undefined && !isValidRelayPort(port)) {
  console.error(`Invalid port: ${process.argv[portFlag + 1]}`);
  process.exit(1);
}

const logFile = daemonLogPath(home);
function log(...args: unknown[]) {
  const line = args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(" ");
  try {
    appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
  } catch {
    // Logging must not stop anything
  }
}

const lockFile = daemonLockPath(home, port);
/** How long a lock may stand without its daemon answering, while it starts */
const LOCK_GRACE_MS = 15_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether a live daemon holds the lock. A dead one's lock, or an old lock on a reused PID, doesn't count */
async function lockIsHeld(): Promise<boolean> {
  let pid: number;
  let age: number;
  try {
    pid = Number(readFileSync(lockFile, "utf8"));
    age = Date.now() - statSync(lockFile).mtimeMs;
  } catch {
    return false;
  }
  if (!pid || !isAlive(pid)) return false;
  if (age < LOCK_GRACE_MS) return true;
  const info = readDaemonInfo(daemonInfoPath(home, port));
  if (!info || info.pid !== pid) return false;
  return (await fetchStatus(info.port))?.pid === pid;
}

async function acquireLock(): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockFile, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      if (await lockIsHeld()) return false;
      rmSync(lockFile, { force: true });
    }
  }
  return false;
}

function releaseLock() {
  try {
    if (Number(readFileSync(lockFile, "utf8")) === process.pid) rmSync(lockFile, { force: true });
  } catch {
    // Gone already
  }
}

async function main() {
  if (!(await acquireLock())) {
    log("another daemon is running: exiting");
    return;
  }
  const daemon = new Daemon({
    home,
    version: VERSION,
    ...(port ? { port } : {}),
    log,
    onExit: () => {
      releaseLock();
      process.exit(0);
    },
  });
  const quit = () => void daemon.stop();
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("exit", releaseLock);
  process.on("uncaughtException", (error) => log("uncaught", error));
  process.on("unhandledRejection", (error) => log("unhandled", error));
  try {
    await daemon.start();
  } catch (error) {
    log("couldn't start", error);
    releaseLock();
    process.exit(1);
  }
}

void main();
