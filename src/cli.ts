import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import type { Transport } from "@modelcontextprotocol/server";
import { realpathSync } from "fs";
import { fileURLToPath } from "url";
import { ensureMemoryFilePath, memoryFileLocationWarning } from "@/memfile.js";
import { createServer } from "@/server.js";

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

export const handleCliError = <T>(error: T) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
};
