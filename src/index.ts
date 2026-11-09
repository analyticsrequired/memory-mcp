#!/usr/bin/env node

// The memory server: a knowledge graph of entities, relations and
// observations, persisted as JSONL and served over MCP as nine tools and one
// subscribable resource. createServer() builds a server over a graph file so
// tests can run it in-process; main() serves it on stdio through the SDK's
// serveStdio entry, which answers 2026-07-28 clients (server/discover, change
// notifications on subscriptions/listen) and 2025-era clients (initialize,
// resources/subscribe) from the same factory (#4852). main() runs only when
// this file is the process entry point, so importing it starts nothing.
import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import type { Transport } from "@modelcontextprotocol/server";
import { promises as fs, realpathSync } from "fs";
import type { FileHandle } from "fs/promises";
import path from "path";
import os from "os";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import { SERVER_VERSION } from "@/version.js";
import { registerTools } from "@/tools.js";
import {
  KnowledgeGraphManager,
  registerKnowledgeGraphResource,
  registerKnowledgeGraphSubscriptions,
} from "@/graph.js";
import { expandHome, pathExists } from "@/utils.js";

// The package directory: where the default graph file lives, and what a
// relative MEMORY_FILE_PATH resolves against.
const defaultMemoryDir = path.dirname(fileURLToPath(import.meta.url));

// Define memory file path using environment variable with fallback
export const defaultMemoryPath = path.join(defaultMemoryDir, "memory.jsonl");

// Handle backward compatibility: migrate memory.json to memory.jsonl if needed.
// baseDir is the directory the default files live in. The server never passes
// it; it exists so tests can run the migration in a temporary directory rather
// than in the package directory, which every importer of this module shares.
export async function ensureMemoryFilePath(
  baseDir: string = defaultMemoryDir,
): Promise<string> {
  if (process.env.MEMORY_FILE_PATH) {
    // Custom path provided. Expand a leading "~" first, then resolve relative
    // paths against the package directory (absolute paths are used as-is).
    const customPath = expandHome(process.env.MEMORY_FILE_PATH);
    return path.isAbsolute(customPath)
      ? customPath
      : path.join(baseDir, customPath);
  }

  // No custom path set, check for backward compatibility migration
  const oldMemoryPath = path.join(baseDir, "memory.json");
  const newMemoryPath = path.join(baseDir, "memory.jsonl");

  // Only a missing legacy file means there is nothing to migrate. Any other
  // failure, from the existence checks or the rename itself, propagates and
  // stops startup: carrying on would serve an empty memory.jsonl while the
  // user's graph sat unread in memory.json (#5203).
  if (!(await pathExists(oldMemoryPath))) {
    return newMemoryPath;
  }
  if (await pathExists(newMemoryPath)) {
    // Both files exist, use new one (no migration needed)
    return newMemoryPath;
  }

  // Old file exists, new file doesn't - migrate
  console.error(
    "DETECTED: Found legacy memory.json file, migrating to memory.jsonl for JSONL format compatibility",
  );
  try {
    await fs.rename(oldMemoryPath, newMemoryPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to migrate legacy memory file ${oldMemoryPath} to ${newMemoryPath}: ${reason}. ` +
        "The server will not start on an empty graph; fix the cause and restart, " +
        "or set MEMORY_FILE_PATH to choose a file explicitly.",
      { cause: error },
    );
  }
  console.error("COMPLETED: Successfully migrated memory.json to memory.jsonl");
  return newMemoryPath;
}

// The startup warning for a memory file inside a node_modules tree, or
// undefined for any other path. npx and npm install the server under
// node_modules, so the default memory.jsonl beside dist/index.js lands there,
// and npm treats that tree as its own: a reinstall, an update or a cleared npx
// cache can delete the file and the graph in it (#4117). The default is not
// moved, since that would strand every existing graph; the warning says how to
// choose a durable path instead. Only node_modules is matched, not the server's
// directory as such: the Docker setup mounts a volume over /app/dist, and a
// source checkout's dist survives a rebuild, so there the default is durable.
export function memoryFileLocationWarning(
  memoryFilePath: string,
): string | undefined {
  // Both separators, so a Windows path is matched on any platform.
  const segments = path.resolve(memoryFilePath).split(/[\\/]/);
  if (!segments.includes("node_modules")) {
    return undefined;
  }
  return (
    `WARNING: the memory file ${memoryFilePath} is inside a node_modules directory, ` +
    "which npm manages: reinstalling or updating the server, or clearing the npx cache, " +
    "can delete it and the knowledge graph it holds. Set MEMORY_FILE_PATH to an absolute " +
    "path outside node_modules, in a directory that exists (for example ~/memory.jsonl), " +
    "and move this file there to keep the graph."
  );
}

// Timings for the cross-process lock around each mutation. Exposed so tests
// can shorten them; the server always uses the defaults.
export interface FileLockOptions {
  // A lock not refreshed for this long is presumed abandoned and is broken.
  staleMs?: number;
  // Give up, failing the mutation, after waiting this long for the lock.
  timeoutMs?: number;
  // Wait between attempts, plus up to the same again of random jitter.
  retryMs?: number;
}

// For best-effort lock cleanup, whose failure must not mask the real outcome.
function ignoreError(): void {}

// Whether opening a lock file failed because the file is held right now. On
// Windows, opening a file that another process is still deleting fails with
// EPERM rather than EEXIST until the deletion completes, so there EPERM means
// "held" too.
function isLockBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EEXIST" || (process.platform === "win32" && code === "EPERM")
  );
}

// Whether the process that wrote a lock file is known to be gone. Only a
// process on this host can be checked; for any other host, or a lock whose
// contents cannot be read, the lock's age decides instead.
function isLockOwnerDead(contents: string): boolean {
  let owner: unknown;
  try {
    owner = JSON.parse(contents);
  } catch {
    return false;
  }
  const { pid, hostname } = (owner ?? {}) as Record<string, unknown>;
  if (typeof pid !== "number" || hostname !== os.hostname()) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

// Whether the lock at lockPath is abandoned. Its owner and its mtime are read
// through one open handle, so both describe the same lock file even if it is
// replaced meanwhile.
async function isLockStale(
  lockPath: string,
  staleMs: number,
): Promise<boolean> {
  const handle = await fs.open(lockPath, "r");
  try {
    const [contents, stats] = await Promise.all([
      handle.readFile("utf-8"),
      handle.stat(),
    ]);
    return isLockOwnerDead(contents) || Date.now() - stats.mtimeMs > staleMs;
  } finally {
    await handle.close();
  }
}

// Remove an abandoned lock, returning whether it did. Breaking is itself
// guarded by a second O_EXCL file, so only one waiter breaks at a time and
// re-checks the lock under that guard: two waiters can never both judge the
// same abandoned lock stale and one then remove the lock the other has just
// taken in its place.
async function breakStaleLock(
  lockPath: string,
  staleMs: number,
): Promise<boolean> {
  const breakerPath = `${lockPath}.break`;
  let breaker: FileHandle;
  try {
    breaker = await fs.open(breakerPath, "wx");
  } catch (error) {
    if (!isLockBusy(error)) {
      throw error;
    }
    // Another waiter is breaking the lock. Its guard is held for a moment
    // only, so one that outlives staleMs was left by a crash: clear it.
    const stats = await fs.stat(breakerPath).catch(() => null);
    if (stats && Date.now() - stats.mtimeMs > staleMs) {
      await fs.unlink(breakerPath).catch(ignoreError);
    }
    return false;
  }
  try {
    await breaker.close();
    if (!(await isLockStale(lockPath, staleMs))) {
      return false;
    }
    console.error(`Breaking stale memory file lock ${lockPath}`);
    await fs.unlink(lockPath);
    return true;
  } finally {
    await fs.unlink(breakerPath).catch(ignoreError);
  }
}

// Run operation while holding an exclusive lock file at lockPath, so that
// mutations from separate server processes sharing one graph file take turns
// and each one loads the graph the previous one saved (#4797). The lock is a
// file created with O_EXCL, which is atomic on local filesystems: exactly one
// creator wins. The holder refreshes the lock's mtime every staleMs / 2 while
// it runs. A lock left behind by a crashed process is broken once its owner
// is known to be dead, or once it has gone unrefreshed for staleMs.
export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  { staleMs = 30_000, timeoutMs = 60_000, retryMs = 10 }: FileLockOptions = {},
): Promise<T> {
  const token = JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    token: randomBytes(16).toString("hex"),
  });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (error) {
      if (!isLockBusy(error)) {
        throw error;
      }
    }
    if (handle) {
      try {
        await handle.writeFile(token);
        await handle.close();
      } catch (error) {
        // The lock was created but not written: remove it rather than leave
        // every other writer waiting for it to go stale.
        await handle.close().catch(ignoreError);
        await fs.unlink(lockPath).catch(ignoreError);
        throw error;
      }
      break;
    }

    // Someone else holds the lock. Break it if it is abandoned; otherwise
    // wait and try again.
    try {
      if (
        (await isLockStale(lockPath, staleMs)) &&
        (await breakStaleLock(lockPath, staleMs))
      ) {
        continue;
      }
    } catch (error) {
      // The holder released the lock between our attempts: try again now.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      // On Windows, the lock is still being deleted: wait, then try again.
      if (!isLockBusy(error)) {
        throw error;
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting for the memory file lock ${lockPath}`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, retryMs + Math.random() * retryMs),
    );
  }

  // Keep the lock fresh while the operation runs, so a mutation that outlasts
  // staleMs (a large graph, a slow disk) is not mistaken for an abandoned one.
  const heartbeat = setInterval(() => {
    const now = new Date();
    fs.utimes(lockPath, now, now).catch(ignoreError);
  }, staleMs / 2);
  heartbeat.unref();

  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    // Release only our own lock: if it was broken as stale while we held it,
    // the file may now belong to another process.
    const current = await fs.readFile(lockPath, "utf-8").catch(() => null);
    if (current === token) {
      await fs.unlink(lockPath).catch(ignoreError);
    }
  }
}

// Build a memory server over the graph file at memoryFilePath: the nine
// tools, the knowledge-graph resource and its subscriptions. main() serves the
// result on stdio; tests connect it to an in-memory transport, so each call
// returns an independent server with its own subscriber set. `era` is the
// protocol era the instance will serve, which decides how graph changes are
// announced (see notifyGraphUpdated).
export function createServer(
  memoryFilePath: string,
  era: "legacy" | "modern" = "legacy",
): McpServer {
  const knowledgeGraphManager = new KnowledgeGraphManager(memoryFilePath);

  const server = new McpServer({
    name: "memory-server",
    version: SERVER_VERSION,
  });

  // Track which resource URIs the connected client has subscribed to, so we only
  // emit notifications/resources/updated to a client that asked for them.
  const resourceSubscribers = new Set<string>();

  registerTools(server, resourceSubscribers, knowledgeGraphManager, era);

  registerKnowledgeGraphResource(server, knowledgeGraphManager);
  registerKnowledgeGraphSubscriptions(server, resourceSubscribers);

  return server;
}

// Serve the server on stdio, writing the graph to the file
// ensureMemoryFilePath picks. The first message the client sends picks the
// connection's protocol era, and the factory builds the server for it. The
// transport is a parameter so a test can run this whole startup path
// in-process; the bin always uses the process's stdio. A transport error,
// including one that stops the transport from starting, is reported on stderr.
export async function main(transport?: Transport): Promise<StdioServerHandle> {
  const memoryFilePath = await ensureMemoryFilePath();
  const locationWarning = memoryFileLocationWarning(memoryFilePath);
  if (locationWarning) {
    console.error(locationWarning);
  }
  const handle = serveStdio(({ era }) => createServer(memoryFilePath, era), {
    transport,
    // serveStdio reports a transport that fails, including one that cannot
    // start, here rather than by rejecting, so record the failure in the
    // exit status for whatever supervises the process.
    onerror: (error) => {
      console.error("Transport error:", error);
      process.exitCode = 1;
    },
  });
  console.error("Knowledge Graph MCP Server running on stdio");
  return handle;
}

// True when this module is the program node was asked to run, rather than a
// module imported by a test. Both sides go through realpath, because npm runs
// the bin through a symlink (node_modules/.bin/memory-mcp).
export function isMainModule(
  entryPath: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  if (!entryPath) {
    return false;
  }
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });
}
