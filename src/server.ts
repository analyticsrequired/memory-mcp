// Build a memory server over the graph file at memoryFilePath: the nine
// tools, the knowledge-graph resource and its subscriptions. main() serves the
// result on stdio; tests connect it to an in-memory transport, so each call
// returns an independent server with its own subscriber set. `era` is the
// protocol era the instance will serve, which decides how graph changes are

import { McpServer } from "@modelcontextprotocol/server";
import {
  KnowledgeGraphManager,
  registerKnowledgeGraphResource,
  registerKnowledgeGraphSubscriptions,
} from "@/graph.js";
import { SERVER_VERSION } from "@/version.js";
import { registerTools } from "@/tools.js";

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
