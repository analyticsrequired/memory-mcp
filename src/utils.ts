import { promises as fs } from "fs";
import path from "path";
import os from "os";

// True when filePath exists, false when it does not (ENOENT). Any other error,
// such as a permission failure, is rethrown rather than read as "missing".
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Expand a leading "~" to the user's home directory. MCP clients pass
// MEMORY_FILE_PATH from JSON config, where no shell performs tilde expansion,
// so an unexpanded "~" would otherwise be treated as a relative path and
// joined onto the package directory. Mirrors the helper of the same name in
// the filesystem server (src/filesystem/path-utils.ts).
export function expandHome(filepath: string): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}
