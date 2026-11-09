import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { FileLockOptions, withFileLock } from "@/memfile.js";
import {
  KnowledgeGraph,
  EntitySchema,
  RelationSchema,
  Entity,
  Relation,
} from "@/schemas.js";
import { McpServer } from "@modelcontextprotocol/server";
import { RESOURCE_URI } from "@/tools.js";

// The KnowledgeGraphManager class contains all operations to interact with the knowledge graph

export class KnowledgeGraphManager {
  constructor(
    private memoryFilePath: string,
    private lockOptions: FileLockOptions = {},
  ) {}

  // Serializes all read-modify-write graph mutations behind a single queue.
  // Without this, concurrent tool calls (e.g. multiple mutations dispatched
  // from one LLM turn) each independently load the graph, mutate their own
  // copy, and write it back — so whichever write lands last silently
  // overwrites the other's changes, and interleaved writes to the same file
  // can corrupt it outright. See #1819.
  // The queue only orders calls within this process, so each queued mutation
  // also holds a lock file next to the graph file while it runs, which orders
  // it against other server processes sharing the same file. See #4797.
  private mutationQueue: Promise<unknown> = Promise.resolve();

  // Members of a stored entity or relation record that the schema does not
  // model (a createdAt written by an older version or another client, say),
  // keyed by the parsed object loadGraphWithUnreadable made from that record.
  // saveGraph writes them back, so a write keeps every record it did not
  // delete exactly as it found it: that is what makes create_entities,
  // create_relations and add_observations additive, as their
  // destructiveHint: false declares (#5058). A WeakMap rather than a property
  // on the object, so the extras never reach a tool result or read_graph,
  // whose output schemas do not allow them, and are collected with the graph
  // they came from. A deleted record is dropped from the graph and takes its
  // extras with it; one changed in place (add_observations,
  // delete_observations) keeps its object, so keeps them too.
  private extraFields = new WeakMap<object, Record<string, unknown>>();

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const locked = () =>
      withFileLock(`${this.memoryFilePath}.lock`, operation, this.lockOptions);
    const result = this.mutationQueue.then(locked, locked);
    // Always resolve the queue itself, even if this operation failed, so a
    // single failed mutation doesn't permanently wedge every call after it.
    // The failure still propagates normally to whoever awaited `result`.
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async loadGraph(): Promise<KnowledgeGraph> {
    return (await this.loadGraphWithUnreadable()).graph;
  }

  // Lines that can't be read (malformed JSON, entries that fail validation,
  // unknown record types) stay out of the in-memory graph, but mutations pass
  // them back to saveGraph so they are written out unchanged. Otherwise the
  // next unrelated write would silently delete them from disk, together with
  // every valid observation of an entity that has one bad field.
  private async loadGraphWithUnreadable(): Promise<{
    graph: KnowledgeGraph;
    unreadable: string[];
  }> {
    try {
      const data = await fs.readFile(this.memoryFilePath, "utf-8");
      const lines = data.split("\n").filter((line) => line.trim() !== "");
      const graph: KnowledgeGraph = { entities: [], relations: [] };
      const unreadable: string[] = [];

      for (const line of lines) {
        let item: unknown;
        try {
          item = JSON.parse(line);
        } catch {
          console.error("Skipping malformed line in memory file");
          unreadable.push(line);
          continue;
        }

        if (typeof item !== "object" || item === null) {
          console.error("Skipping non-object line in memory file");
          unreadable.push(line);
          continue;
        }

        const record = item as Record<string, unknown>;
        if (record.type === "entity") {
          const parsed = EntitySchema.safeParse(item);
          if (parsed.success) {
            this.keepExtraFields(parsed.data, record, EntitySchema.shape);
            graph.entities.push(parsed.data);
          } else {
            unreadable.push(line);
            console.error(
              "Skipping invalid entity in memory file:",
              parsed.error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join(", "),
            );
          }
        } else if (record.type === "relation") {
          const parsed = RelationSchema.safeParse(item);
          if (parsed.success) {
            this.keepExtraFields(parsed.data, record, RelationSchema.shape);
            graph.relations.push(parsed.data);
          } else {
            unreadable.push(line);
            console.error(
              "Skipping invalid relation in memory file:",
              parsed.error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join(", "),
            );
          }
        } else {
          unreadable.push(line);
        }
      }

      return { graph, unreadable };
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { graph: { entities: [], relations: [] }, unreadable: [] };
      }
      throw error;
    }
  }

  // Record the members of a valid stored record that are neither its type nor
  // a field of its schema, for saveGraph to write back. Object.fromEntries
  // defines each key as an own property, so even a "__proto__" member stays
  // data rather than setting the object's prototype.
  private keepExtraFields(
    parsed: object,
    record: Record<string, unknown>,
    shape: Record<string, unknown>,
  ): void {
    const extras = Object.entries(record).filter(
      ([key]) => key !== "type" && !Object.hasOwn(shape, key),
    );
    if (extras.length > 0) {
      this.extraFields.set(parsed, Object.fromEntries(extras));
    }
  }

  private async saveGraph(
    graph: KnowledgeGraph,
    unreadable: string[],
  ): Promise<void> {
    // The modelled fields come first and always hold the current values; a
    // record's extras (see extraFields) follow unchanged. A record created by
    // this write has none and is written exactly as before.
    const lines = [
      ...graph.entities.map((e) =>
        JSON.stringify({
          type: "entity",
          name: e.name,
          entityType: e.entityType,
          observations: e.observations,
          ...this.extraFields.get(e),
        }),
      ),
      ...graph.relations.map((r) =>
        JSON.stringify({
          type: "relation",
          from: r.from,
          to: r.to,
          relationType: r.relationType,
          ...this.extraFields.get(r),
        }),
      ),
      ...unreadable,
    ];

    // Write to a temporary file in the same directory, then rename it over
    // the target. fs.writeFile would truncate the memory file before writing,
    // so an interruption (SIGKILL, container stop, OOM, power loss) would
    // leave the only copy of the graph truncated and unrecoverable.
    // rename(2) is atomic on POSIX filesystems: readers see either the
    // complete old file or the complete new one, never a partial state.
    // The temp file is kept in the same directory so the rename stays on one
    // filesystem — renaming across mount points fails with EXDEV.
    //
    // The rename also replaces the graph file's inode, and a new file takes
    // the process umask, so the file's own mode would be lost (#4827): an
    // operator's 0600 would come back 0644, and a read-only file would be
    // silently replaced, since rename(2) needs only a writable directory.
    // So refuse a graph file this process may not write, as fs.writeFile
    // would (EACCES), and give the temp file the existing file's permission
    // bits before the rename, as src/filesystem/lib.ts preserves them for
    // the same write pattern. A graph file that does not exist yet has
    // nothing to preserve.
    let mode: number | undefined;
    try {
      await fs.access(this.memoryFilePath, fs.constants.W_OK);
      mode = (await fs.stat(this.memoryFilePath)).mode & 0o777;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }

    const directory = path.dirname(this.memoryFilePath);
    const tempFilePath = path.join(
      directory,
      `${path.basename(this.memoryFilePath)}.${randomBytes(16).toString("hex")}.tmp`,
    );

    try {
      // Create the temp file with the existing mode, so the graph is never
      // readable through it more widely than through the file it replaces;
      // the umask can only narrow that. The chmod then restores any bits the
      // umask removed.
      await fs.writeFile(
        tempFilePath,
        lines.join("\n") + "\n",
        mode === undefined ? undefined : { mode },
      );
      if (mode !== undefined) {
        await fs.chmod(tempFilePath, mode);
      }
      await fs.rename(tempFilePath, this.memoryFilePath);
    } catch (error) {
      // Never leave a stray temp file behind on failure.
      await fs.unlink(tempFilePath).catch(() => {});
      throw error;
    }
  }

  async createEntities(entities: Entity[]): Promise<Entity[]> {
    return this.withLock(async () => {
      const { graph, unreadable } = await this.loadGraphWithUnreadable();
      const newEntities = entities.filter(
        (e, index) =>
          !graph.entities.some(
            (existingEntity) => existingEntity.name === e.name,
          ) &&
          // Also skip duplicates appearing earlier in this same batch
          !entities.slice(0, index).some((earlier) => earlier.name === e.name),
      );
      graph.entities.push(...newEntities);
      await this.saveGraph(graph, unreadable);
      return newEntities;
    });
  }

  async createRelations(relations: Relation[]): Promise<Relation[]> {
    return this.withLock(async () => {
      const { graph, unreadable } = await this.loadGraphWithUnreadable();
      const entityNames = new Set(graph.entities.map((e) => e.name));

      relations.forEach((r) => {
        if (!entityNames.has(r.from)) {
          throw new Error(`Entity with name ${r.from} not found`);
        }
        if (!entityNames.has(r.to)) {
          throw new Error(`Entity with name ${r.to} not found`);
        }
      });

      const isSameRelation = (a: Relation, b: Relation) =>
        a.from === b.from && a.to === b.to && a.relationType === b.relationType;
      const newRelations = relations.filter(
        (r, index) =>
          !graph.relations.some((existingRelation) =>
            isSameRelation(existingRelation, r),
          ) &&
          // Also skip duplicates appearing earlier in this same batch
          !relations
            .slice(0, index)
            .some((earlier) => isSameRelation(earlier, r)),
      );
      graph.relations.push(...newRelations);
      await this.saveGraph(graph, unreadable);
      return newRelations;
    });
  }

  async addObservations(
    observations: { entityName: string; contents: string[] }[],
  ): Promise<{ entityName: string; addedObservations: string[] }[]> {
    return this.withLock(async () => {
      const { graph, unreadable } = await this.loadGraphWithUnreadable();
      const results = observations.map((o) => {
        const entity = graph.entities.find((e) => e.name === o.entityName);
        if (!entity) {
          throw new Error(`Entity with name ${o.entityName} not found`);
        }
        // A Set keeps the first occurrence of each string, so a repeat within
        // one call is stored and reported once (#5201).
        const newObservations = [...new Set(o.contents)].filter(
          (content) => !entity.observations.includes(content),
        );
        entity.observations.push(...newObservations);
        return { entityName: o.entityName, addedObservations: newObservations };
      });
      await this.saveGraph(graph, unreadable);
      return results;
    });
  }

  async deleteEntities(
    entityNames: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }> {
    return this.withLock(async () => {
      const { graph, unreadable } = await this.loadGraphWithUnreadable();
      const present = new Set(graph.entities.map((e) => e.name));
      const deleted = entityNames.filter((name) => present.has(name));
      const notFound = entityNames.filter((name) => !present.has(name));
      graph.entities = graph.entities.filter(
        (e) => !entityNames.includes(e.name),
      );
      graph.relations = graph.relations.filter(
        (r) => !entityNames.includes(r.from) && !entityNames.includes(r.to),
      );
      await this.saveGraph(graph, unreadable);
      return { deleted, notFound };
    });
  }

  async deleteObservations(
    deletions: { entityName: string; observations: string[] }[],
  ): Promise<{ deletedCount: number; missingEntities: string[] }> {
    return this.withLock(async () => {
      const { graph, unreadable } = await this.loadGraphWithUnreadable();
      let deletedCount = 0;
      const missingEntities: string[] = [];
      deletions.forEach((d) => {
        const entity = graph.entities.find((e) => e.name === d.entityName);
        if (entity) {
          const before = entity.observations.length;
          entity.observations = entity.observations.filter(
            (o) => !d.observations.includes(o),
          );
          deletedCount += before - entity.observations.length;
        } else {
          missingEntities.push(d.entityName);
        }
      });
      await this.saveGraph(graph, unreadable);
      return { deletedCount, missingEntities };
    });
  }

  async deleteRelations(
    relations: Relation[],
  ): Promise<{ deletedCount: number }> {
    return this.withLock(async () => {
      const { graph, unreadable } = await this.loadGraphWithUnreadable();
      const before = graph.relations.length;
      graph.relations = graph.relations.filter(
        (r) =>
          !relations.some(
            (delRelation) =>
              r.from === delRelation.from &&
              r.to === delRelation.to &&
              r.relationType === delRelation.relationType,
          ),
      );
      await this.saveGraph(graph, unreadable);
      return { deletedCount: before - graph.relations.length };
    });
  }

  // With no options, the whole graph, as the knowledge-graph resource serves
  // it. entityTypes keeps only entities of those types, and the relations
  // that touch one of them; observationLimit caps each entity's observations
  // (see limitObservations).
  async readGraph(options: ReadGraphOptions = {}): Promise<ReadGraphResult> {
    const graph = await this.loadGraph();
    const { entityTypes, observationLimit } = options;
    if (entityTypes === undefined) {
      return {
        entities: limitObservations(graph.entities, observationLimit),
        relations: graph.relations,
      };
    }
    const entities = graph.entities.filter((e) =>
      entityTypes.includes(e.entityType),
    );
    const names = new Set(entities.map((e) => e.name));
    return {
      entities: limitObservations(entities, observationLimit),
      relations: graph.relations.filter(
        (r) => names.has(r.from) || names.has(r.to),
      ),
    };
  }

  // Very basic search function. limit keeps the first matches in stored
  // order; observationLimit caps each entity's observations.
  async searchNodes(
    query: string,
    options: SearchNodesOptions = {},
  ): Promise<ReadGraphResult> {
    const graph = await this.loadGraph();

    // Filter entities
    const filteredEntities = graph.entities
      .filter(
        (e) =>
          e.name.toLowerCase().includes(query.toLowerCase()) ||
          e.entityType.toLowerCase().includes(query.toLowerCase()) ||
          e.observations.some((o) =>
            o.toLowerCase().includes(query.toLowerCase()),
          ),
      )
      .slice(0, options.limit);

    // Create a Set of filtered entity names for quick lookup
    const filteredEntityNames = new Set(filteredEntities.map((e) => e.name));

    // Include relations where at least one endpoint matches the search results.
    // This lets callers discover connections to nodes outside the result set.
    const filteredRelations = graph.relations.filter(
      (r) => filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to),
    );

    return {
      entities: limitObservations(filteredEntities, options.observationLimit),
      relations: filteredRelations,
    };
  }

  async openNodes(
    names: string[],
    options: OpenNodesOptions = {},
  ): Promise<ReadGraphResult> {
    const graph = await this.loadGraph();

    // Filter entities
    const filteredEntities = graph.entities.filter((e) =>
      names.includes(e.name),
    );

    // Create a Set of filtered entity names for quick lookup
    const filteredEntityNames = new Set(filteredEntities.map((e) => e.name));

    // Include relations where at least one endpoint is in the requested set.
    // Previously this required BOTH endpoints, which meant relations from a
    // requested node to an unrequested node were silently dropped — making it
    // impossible to discover a node's connections without reading the full graph.
    const filteredRelations = graph.relations.filter(
      (r) => filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to),
    );

    return {
      entities: limitObservations(filteredEntities, options.observationLimit),
      relations: filteredRelations,
    };
  }
}

export function registerKnowledgeGraphResource(
  server: McpServer,
  manager: KnowledgeGraphManager,
) {
  server.registerResource(
    "knowledge-graph",
    RESOURCE_URI,
    {
      title: "Knowledge Graph",
      description: "The full knowledge graph with all entities and relations",
      mimeType: "application/json",
    },
    async (uri) => {
      const graph = await manager.readGraph();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(graph, null, 2),
          },
        ],
      };
    },
  );
}

// Enable clients to subscribe to the knowledge-graph resource and receive
// notifications/resources/updated when mutation tools change the graph. The
// subscribe and unsubscribe methods exist only on the 2025 protocol era; the
// `subscribe` capability also lets a 2026-07-28 client name the resource in
// its subscriptions/listen filter.
export function registerKnowledgeGraphSubscriptions(
  server: McpServer,
  resourceSubscribers: Set<string>,
) {
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler("resources/subscribe", async (request) => {
    resourceSubscribers.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler("resources/unsubscribe", async (request) => {
    resourceSubscribers.delete(request.params.uri);
    return {};
  });
}

export interface ReadGraphResult {
  entities: ReadEntity[];
  relations: Relation[];
}

// An entity as a read tool returns it. observationCount is set only when
// observationLimit was given, so a count above observations.length tells the
// caller that observations were left out.
export interface ReadEntity extends Entity {
  observationCount?: number;
}

export interface ReadGraphOptions extends OpenNodesOptions {
  entityTypes?: string[];
}

// Options of the read tools (#3953), all optional, so a call without them
// returns what it always has. They let a client read a large graph in
// pieces: an overview of names, types and observation counts first
// (observationLimit 0), then the entities it needs in full.
export interface OpenNodesOptions {
  observationLimit?: number;
}

export interface SearchNodesOptions extends OpenNodesOptions {
  limit?: number;
}

// Keep each entity's first observationLimit observations, in the order they
// were added, and record how many it holds. Without a limit the entities are
// returned as they are.
export function limitObservations(
  entities: Entity[],
  observationLimit: number | undefined,
): ReadEntity[] {
  if (observationLimit === undefined) {
    return entities;
  }
  return entities.map((e) => ({
    name: e.name,
    entityType: e.entityType,
    observations: e.observations.slice(0, observationLimit),
    observationCount: e.observations.length,
  }));
}
