import { McpServer } from "@modelcontextprotocol/server";
import z from "zod";
import {
  EntitySchema,
  EntityInputSchema,
  RelationSchema,
  RelationInputSchema,
  NamespaceInputSchema,
  NamespaceSchema,
  NamespaceSummarySchema,
  ReadGraphEntityTypesSchema,
  ObservationLimitSchema,
  ReadEntitySchema,
  SearchNodesQuerySchema,
  SearchNodesLimitSchema,
} from "@/schemas.js";
import { KnowledgeGraphManager } from "@/graph.js";

export const RESOURCE_URI = "memory://knowledge-graph";

// What rename_namespace and delete_namespace return: the status every
// mutation tool reports, with how many entities and relations it affected.
const NamespaceChangeOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  entityCount: z.number().int().min(0),
  relationCount: z.number().int().min(0),
});

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
        namespace: NamespaceInputSchema,
        entities: z.array(EntityInputSchema),
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
    async ({ namespace, entities }) => {
      const result = await knowledgeGraphManager.createEntities(
        namespace,
        entities,
      );
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
        namespace: NamespaceInputSchema,
        relations: z.array(RelationInputSchema),
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
    async ({ namespace, relations }) => {
      const result = await knowledgeGraphManager.createRelations(
        namespace,
        relations,
      );
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
        namespace: NamespaceInputSchema,
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
    async ({ namespace, observations }) => {
      const result = await knowledgeGraphManager.addObservations(
        namespace,
        observations,
      );
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
        namespace: NamespaceInputSchema,
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
    async ({ namespace, entityNames }) => {
      const { deleted, notFound } = await knowledgeGraphManager.deleteEntities(
        namespace,
        entityNames,
      );
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
        namespace: NamespaceInputSchema,
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
    async ({ namespace, deletions }) => {
      const { deletedCount, missingEntities } =
        await knowledgeGraphManager.deleteObservations(namespace, deletions);
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
        namespace: NamespaceInputSchema,
        relations: z
          .array(RelationInputSchema)
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
    async ({ namespace, relations }) => {
      const { deletedCount } = await knowledgeGraphManager.deleteRelations(
        namespace,
        relations,
      );
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
        namespace: NamespaceInputSchema,
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
    async ({ namespace, entityTypes, observationLimit }) => {
      const graph = await knowledgeGraphManager.readGraph(namespace, {
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
        namespace: NamespaceInputSchema,
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
    async ({ namespace, query, limit, observationLimit }) => {
      const graph = await knowledgeGraphManager.searchNodes(namespace, query, {
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
        namespace: NamespaceInputSchema,
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
    async ({ namespace, names, observationLimit }) => {
      const graph = await knowledgeGraphManager.openNodes(namespace, names, {
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

  // Register create_namespace tool
  server.registerTool(
    "create_namespace",
    {
      title: "Create Namespace",
      description:
        "Create a namespace, which is where entities and relations live: every other tool takes the namespace to work in, and it must exist. Fails if a namespace of that name already exists, so reuse the existing one (see list_namespaces) rather than creating it again. Names are case-sensitive.",
      inputSchema: z.object({
        namespace: NamespaceSchema.describe(
          "The name of the namespace to create",
        ),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ namespace }) => {
      await knowledgeGraphManager.createNamespace(namespace);
      notifyGraphUpdated();
      const message = `Created namespace ${namespace}`;
      return {
        content: [{ type: "text" as const, text: message }],
        structuredContent: { success: true, message },
      };
    },
  );

  // Register list_namespaces tool
  server.registerTool(
    "list_namespaces",
    {
      title: "List Namespaces",
      description:
        "List the namespaces of the knowledge graph, each with its number of entities and relations (0 for a namespace nothing is in yet). Use this to find out which namespaces exist before reading from or writing to one; every other tool works inside the namespace named by its required `namespace` input, which must exist.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        namespaces: z.array(NamespaceSummarySchema),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const namespaces = await knowledgeGraphManager.listNamespaces();
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(namespaces, null, 2) },
        ],
        structuredContent: { namespaces },
      };
    },
  );

  // Register rename_namespace tool
  server.registerTool(
    "rename_namespace",
    {
      title: "Rename Namespace",
      description:
        "Rename a namespace: every entity and relation in it moves to the new name. Fails if the namespace does not exist, or if the new name already exists, since namespaces are never merged.",
      inputSchema: z.object({
        namespace: NamespaceSchema.describe(
          "The current name of the namespace to rename; it must exist",
        ),
        newNamespace: NamespaceSchema.describe(
          "The new name of the namespace; it must not exist",
        ),
      }),
      outputSchema: NamespaceChangeOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ namespace, newNamespace }) => {
      const { entityCount, relationCount } =
        await knowledgeGraphManager.renameNamespace(namespace, newNamespace);
      notifyGraphUpdated();
      const message = `Renamed namespace ${namespace} to ${newNamespace}: moved ${entityCount} ${entityCount === 1 ? "entity" : "entities"} and ${relationCount} ${relationCount === 1 ? "relation" : "relations"}`;
      return {
        content: [{ type: "text" as const, text: message }],
        structuredContent: {
          success: true,
          message,
          entityCount,
          relationCount,
        },
      };
    },
  );

  // Register delete_namespace tool
  server.registerTool(
    "delete_namespace",
    {
      title: "Delete Namespace",
      description:
        "Delete a namespace with every entity and relation in it. This cannot be undone. A namespace that does not exist is not an error; the response reports 0 deleted.",
      inputSchema: z.object({
        namespace: NamespaceSchema.describe(
          "The namespace to delete, with everything in it",
        ),
      }),
      outputSchema: NamespaceChangeOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ namespace }) => {
      const { entityCount, relationCount } =
        await knowledgeGraphManager.deleteNamespace(namespace);
      notifyGraphUpdated();
      const message =
        entityCount === 0 && relationCount === 0
          ? `Namespace ${namespace} does not exist or holds nothing, so nothing was deleted`
          : `Deleted namespace ${namespace}: ${entityCount} ${entityCount === 1 ? "entity" : "entities"} and ${relationCount} ${relationCount === 1 ? "relation" : "relations"}`;
      return {
        content: [{ type: "text" as const, text: message }],
        structuredContent: {
          success: true,
          message,
          entityCount,
          relationCount,
        },
      };
    },
  );
};

// Names of requested entities that createEntities did not create: the name
// already existed in the namespace, or repeated earlier in the same batch.
// createEntities keeps the first request of each new name, so a request is
// skipped unless it is the first of a name that was created.
export function skippedEntityNames(
  requested: { name: string }[],
  created: { name: string }[],
): string[] {
  const awaitingFirst = new Set(created.map((e) => e.name));
  return requested
    .filter((e) => !awaitingFirst.delete(e.name))
    .map((e) => e.name);
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
