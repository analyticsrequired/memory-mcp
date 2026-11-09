import { McpServer } from "@modelcontextprotocol/server";
import z from "zod";
import {
  EntitySchema,
  RelationSchema,
  ReadGraphEntityTypesSchema,
  ObservationLimitSchema,
  ReadEntitySchema,
  Entity,
  SearchNodesQuerySchema,
  SearchNodesLimitSchema,
} from "@/schemas.js";
import { KnowledgeGraphManager } from "@/graph.js";

export const RESOURCE_URI = "memory://knowledge-graph";

export const registerTools = (
  server: McpServer,
  resourceSubscribers: Set<string>,
  knowledgeGraphManager: KnowledgeGraphManager,
  era: "legacy" | "modern",
) => {
  // Notify subscribers that the knowledge graph resource changed. A 2025-era
  // client subscribes with resources/subscribe, so the notification is sent
  // only once it has. On 2026-07-28 that method does not exist: a client asks
  // for updates in its subscriptions/listen filter, and serveStdio delivers
  // the notification only to a listen stream that named the URI, so it is
  // always handed over.
  function notifyGraphUpdated() {
    if (era === "modern" || resourceSubscribers.has(RESOURCE_URI)) {
      // Fire-and-forget: the tool result must not wait on (or fail because of)
      // the notification, so a delivery failure is logged rather than thrown.
      server.server
        .sendResourceUpdated({ uri: RESOURCE_URI })
        .catch((error: unknown) => {
          console.error("Failed to send resource updated notification:", error);
        });
    }
  }

  // Register create_entities tool
  server.registerTool(
    "create_entities",
    {
      title: "Create Entities",
      description:
        "Create multiple new entities in the knowledge graph. An entity whose name already exists, or repeats an earlier entity in the same call, is skipped and its observations are not added; the result lists the skipped names in `skipped`. Use add_observations to add observations to an existing entity.",
      inputSchema: z.object({
        entities: z.array(EntitySchema),
      }),
      outputSchema: z.object({
        entities: z.array(EntitySchema),
        // Present only when at least one requested entity was skipped.
        skipped: z.array(z.string()).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ entities }) => {
      const result = await knowledgeGraphManager.createEntities(entities);
      notifyGraphUpdated();
      // Existing names are ignored (see README). Say so: otherwise an agent
      // reads the response as its observations having been stored.
      const skipped = skippedEntityNames(entities, result);
      const content = [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ];
      if (skipped.length > 0) {
        content.push({
          type: "text" as const,
          text: skippedEntitiesNotice(skipped),
        });
      }
      return {
        content,
        structuredContent:
          skipped.length > 0
            ? { entities: result, skipped }
            : { entities: result },
      };
    },
  );

  // Register create_relations tool
  server.registerTool(
    "create_relations",
    {
      title: "Create Relations",
      description:
        "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
      inputSchema: z.object({
        relations: z.array(RelationSchema),
      }),
      outputSchema: z.object({
        relations: z.array(RelationSchema),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ relations }) => {
      const result = await knowledgeGraphManager.createRelations(relations);
      notifyGraphUpdated();
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
        structuredContent: { relations: result },
      };
    },
  );

  // Register add_observations tool
  server.registerTool(
    "add_observations",
    {
      title: "Add Observations",
      description:
        "Add new observations to existing entities in the knowledge graph",
      inputSchema: z.object({
        observations: z.array(
          z.object({
            entityName: z
              .string()
              .describe("The name of the entity to add the observations to"),
            contents: z
              .array(z.string())
              .describe("An array of observation contents to add"),
          }),
        ),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            entityName: z.string(),
            addedObservations: z.array(z.string()),
          }),
        ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ observations }) => {
      const result = await knowledgeGraphManager.addObservations(observations);
      notifyGraphUpdated();
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
        structuredContent: { results: result },
      };
    },
  );

  // Register delete_entities tool
  server.registerTool(
    "delete_entities",
    {
      title: "Delete Entities",
      description:
        "Delete multiple entities and their associated relations from the knowledge graph",
      inputSchema: z.object({
        entityNames: z
          .array(z.string())
          .describe("An array of entity names to delete"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ entityNames }) => {
      const { deleted, notFound } =
        await knowledgeGraphManager.deleteEntities(entityNames);
      notifyGraphUpdated();
      const message =
        notFound.length === 0
          ? "Entities deleted successfully"
          : `Deleted ${deleted.length} of ${entityNames.length} entities. Not found: ${notFound.join(", ")}`;
      return {
        content: [{ type: "text" as const, text: message }],
        structuredContent: { success: true, message },
      };
    },
  );

  // Register delete_observations tool
  server.registerTool(
    "delete_observations",
    {
      title: "Delete Observations",
      description:
        "Delete specific observations from entities in the knowledge graph",
      inputSchema: z.object({
        deletions: z.array(
          z.object({
            entityName: z
              .string()
              .describe("The name of the entity containing the observations"),
            observations: z
              .array(z.string())
              .describe("An array of observations to delete"),
          }),
        ),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ deletions }) => {
      const { deletedCount, missingEntities } =
        await knowledgeGraphManager.deleteObservations(deletions);
      notifyGraphUpdated();
      const requested = deletions.reduce(
        (total, d) => total + d.observations.length,
        0,
      );
      const message =
        deletedCount === requested
          ? "Observations deleted successfully"
          : `Deleted ${deletedCount} of ${requested} observations.` +
            (missingEntities.length
              ? ` Entities not found: ${missingEntities.join(", ")}`
              : "");
      return {
        content: [{ type: "text" as const, text: message }],
        structuredContent: { success: true, message },
      };
    },
  );

  // Register delete_relations tool
  server.registerTool(
    "delete_relations",
    {
      title: "Delete Relations",
      description: "Delete multiple relations from the knowledge graph",
      inputSchema: z.object({
        relations: z
          .array(RelationSchema)
          .describe("An array of relations to delete"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ relations }) => {
      const { deletedCount } =
        await knowledgeGraphManager.deleteRelations(relations);
      notifyGraphUpdated();
      const message =
        deletedCount === relations.length
          ? "Relations deleted successfully"
          : `Deleted ${deletedCount} of ${relations.length} relations. The rest matched nothing.`;
      return {
        content: [{ type: "text" as const, text: message }],
        structuredContent: { success: true, message },
      };
    },
  );

  // Register read_graph tool
  server.registerTool(
    "read_graph",
    {
      title: "Read Graph",
      description:
        "Read the entire knowledge graph: every entity with its observations, and every relation. The result grows with the graph, so use this only when you need everything; prefer search_nodes to find entities by keyword and open_nodes to read entities whose names you know.",
      inputSchema: z.object({
        entityTypes: ReadGraphEntityTypesSchema,
        observationLimit: ObservationLimitSchema,
      }),
      outputSchema: z.object({
        entities: z.array(ReadEntitySchema),
        relations: z.array(RelationSchema),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ entityTypes, observationLimit }) => {
      const graph = await knowledgeGraphManager.readGraph({
        entityTypes,
        observationLimit,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(graph, null, 2) },
        ],
        structuredContent: { ...graph },
      };
    },
  );

  // Register search_nodes tool
  server.registerTool(
    "search_nodes",
    {
      title: "Search Nodes",
      description:
        "Search the knowledge graph for entities whose name, type or observations contain the query (case-insensitive). Use this when you have a keyword, a topic or part of a name but not the exact entity names. Prefer open_nodes when you already know the exact names, and use read_graph only when you need the whole graph. Returns the matching entities and every relation that touches one of them.",
      inputSchema: z.object({
        query: SearchNodesQuerySchema,
        limit: SearchNodesLimitSchema,
        observationLimit: ObservationLimitSchema,
      }),
      outputSchema: z.object({
        entities: z.array(ReadEntitySchema),
        relations: z.array(RelationSchema),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit, observationLimit }) => {
      const graph = await knowledgeGraphManager.searchNodes(query, {
        limit,
        observationLimit,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(graph, null, 2) },
        ],
        structuredContent: { ...graph },
      };
    },
  );

  // Register open_nodes tool
  server.registerTool(
    "open_nodes",
    {
      title: "Open Nodes",
      description:
        "Retrieve specific entities by their exact names, with every relation that touches one of them. Use this when you already know the names (from the conversation, or from an earlier search_nodes or read_graph result); it is the cheapest way to read entities you can name. Prefer search_nodes when you only have a keyword or part of a name. Names that do not exist are skipped.",
      inputSchema: z.object({
        names: z
          .array(z.string())
          .describe("An array of entity names to retrieve"),
        observationLimit: ObservationLimitSchema,
      }),
      outputSchema: z.object({
        entities: z.array(ReadEntitySchema),
        relations: z.array(RelationSchema),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ names, observationLimit }) => {
      const graph = await knowledgeGraphManager.openNodes(names, {
        observationLimit,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(graph, null, 2) },
        ],
        structuredContent: { ...graph },
      };
    },
  );
};

// Names of requested entities that createEntities did not create: the name
// already existed, or repeated earlier in the same batch. createEntities
// returns the created entities themselves, so identity tells them apart.
export function skippedEntityNames(
  requested: Entity[],
  created: Entity[],
): string[] {
  return requested.filter((e) => !created.includes(e)).map((e) => e.name);
}

// Text telling the agent which entities create_entities skipped.
export function skippedEntitiesNotice(skipped: string[]): string {
  const one = skipped.length === 1;
  return (
    `Skipped ${skipped.length} ${one ? "entity that already exists" : "entities that already exist"}: ` +
    `${skipped.join(", ")}. ${one ? "Its" : "Their"} observations were not added; ` +
    "use add_observations for existing entities."
  );
}
