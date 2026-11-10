import { z } from "zod";

const SEARCH_QUERY_MAX_LENGTH = 2048;
const NAMESPACE_MAX_LENGTH = 256;

// A namespace is an exact, case-sensitive string, like an entity name.
export const NamespaceSchema = z
  .string()
  .min(1)
  .max(NAMESPACE_MAX_LENGTH)
  .describe("The namespace the entity or relation belongs to");

// The `namespace` input of every tool that works inside a namespace. It is
// required, and the namespace must exist (see create_namespace): the caller is
// always explicit about where it reads and writes.
export const NamespaceInputSchema = z
  .string()
  .min(1)
  .max(NAMESPACE_MAX_LENGTH)
  .describe(
    "The namespace to operate in (required). It must already exist: create it with create_namespace, and list the existing ones with list_namespaces. Namespaces are isolated from each other: the same entity name can exist in several, and a relation only connects entities in its own namespace.",
  );

// Zod schemas for entities and relations. A tool that creates them takes the
// namespace once, as its own input, and the items it receives are the *Input
// schemas, without a namespace; the others are what a tool returns.
export const EntitySchema = z.object({
  name: z.string().describe("The name of the entity"),
  entityType: z.string().describe("The type of the entity"),
  observations: z
    .array(z.string())
    .describe("An array of observation contents associated with the entity"),
  namespace: NamespaceSchema,
});

export const EntityInputSchema = EntitySchema.omit({ namespace: true });

export const RelationSchema = z.object({
  from: z.string().describe("The name of the entity where the relation starts"),
  to: z.string().describe("The name of the entity where the relation ends"),
  relationType: z.string().describe("The type of the relation"),
  namespace: NamespaceSchema,
});

export const RelationInputSchema = RelationSchema.omit({ namespace: true });

// A namespace is stored as a record of its own, so that one can exist before
// anything is in it.
export const NamespaceRecordSchema = z.object({ name: NamespaceSchema });

// We are storing our memory using entities, relations, and observations in a graph structure
export interface Entity {
  name: string;
  entityType: string;
  observations: string[];
  namespace: string;
}

export type EntityInput = Omit<Entity, "namespace">;

export interface Relation {
  from: string;
  to: string;
  relationType: string;
  namespace: string;
}

export type RelationInput = Omit<Relation, "namespace">;

// The namespaces that were created with create_namespace. A namespace also
// exists while any entity or relation names it, so one needs no record of its
// own when a file was edited by hand to hold records in it.
export interface NamespaceRecord {
  name: string;
}

export interface KnowledgeGraph {
  namespaces: NamespaceRecord[];
  entities: Entity[];
  relations: Relation[];
}

// What list_namespaces reports for one namespace.
export const NamespaceSummarySchema = z.object({
  namespace: z.string().describe("The namespace"),
  entityCount: z
    .number()
    .int()
    .min(0)
    .describe("How many entities the namespace holds"),
  relationCount: z
    .number()
    .int()
    .min(0)
    .describe("How many relations the namespace holds"),
});

export type NamespaceSummary = z.infer<typeof NamespaceSummarySchema>;

export const SearchNodesQuerySchema = z
  .string()
  .max(SEARCH_QUERY_MAX_LENGTH)
  .describe(
    "The search query to match against entity names, types, and observation content",
  );

// The read tools' optional inputs (#3953). Their descriptions carry the
// guidance on when to use them, so the tool descriptions need not.
export const ObservationLimitSchema = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    "Return at most this many observations per entity (the first ones, in the order they were added) and add each entity's total as observationCount. Use 0 for names, types and counts only: a cheap overview of a large graph, after which open_nodes reads the entities you need in full. Omit to return every observation.",
  );

export const ReadGraphEntityTypesSchema = z
  .array(z.string())
  .min(1)
  .optional()
  .describe(
    "Return only entities whose entityType is one of these (exact match), and only the relations that touch one of them. Omit to return every entity.",
  );

export const SearchNodesLimitSchema = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(
    "Return at most this many matching entities (the first matches, in stored order), with the relations that touch them. Omit to return every match.",
  );

// An entity in a read tool's result: observationCount appears only when the
// call gave observationLimit.
export const ReadEntitySchema = EntitySchema.extend({
  observationCount: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "How many observations the entity holds in total; present only when observationLimit was given",
    ),
});
