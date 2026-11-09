import { z } from "zod";

const SEARCH_QUERY_MAX_LENGTH = 2048;

// Zod schemas for entities and relations
export const EntitySchema = z.object({
  name: z.string().describe("The name of the entity"),
  entityType: z.string().describe("The type of the entity"),
  observations: z
    .array(z.string())
    .describe("An array of observation contents associated with the entity"),
});

export const RelationSchema = z.object({
  from: z.string().describe("The name of the entity where the relation starts"),
  to: z.string().describe("The name of the entity where the relation ends"),
  relationType: z.string().describe("The type of the relation"),
});

// We are storing our memory using entities, relations, and observations in a graph structure
export interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}

export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

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
