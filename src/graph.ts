import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { FileLockOptions, withFileLock } from "@/memfile.js";
import {
  KnowledgeGraph,
  StoredEntitySchema,
  StoredRelationSchema,
  NamespaceRecordSchema,
  Entity,
  EntityInput,
  Relation,
  RelationInput,
  NamespaceSummary,
} from "@/schemas.js";
import { McpServer } from "@modelcontextprotocol/server";
import { RESOURCE_URI } from "@/tools.js";

// The KnowledgeGraphManager class contains all operations to interact with the knowledge graph.
//
// Every entity and relation belongs to one namespace, and a namespace is a
// closed world: an entity is identified by its namespace and name together,
// and a relation connects entities of its own namespace only. Every operation
// is given the namespace it works in; none has a default. A namespace is
// created explicitly (createNamespace) and an operation on one that does not
// exist fails, so a mistyped name is an error rather than an empty graph.
// A namespace exists once created, and also while any stored entity or
// relation names it, which is how the records of a file written before
// namespaces existed (the legacy namespace) have a namespace at all.

function namespaceExists(graph: KnowledgeGraph, namespace: string): boolean {
  return (
    graph.namespaces.some((n) => n.name === namespace) ||
    graph.entities.some((e) => e.namespace === namespace) ||
    graph.relations.some((r) => r.namespace === namespace)
  );
}

// Fail unless the namespace exists, saying how to find or make one.
function requireNamespace(graph: KnowledgeGraph, namespace: string): void {
  if (!namespaceExists(graph, namespace)) {
    throw new Error(
      `Namespace ${namespace} does not exist; create it with create_namespace, or list the existing ones with list_namespaces`,
    );
  }
}

function entityNotFound(name: string, namespace: string): Error {
  return new Error(
    `Entity with name ${name} not found in namespace ${namespace}`,
  );
}

// The entities and relations of one namespace.
function inNamespace(graph: KnowledgeGraph, namespace: string): KnowledgeGraph {
  return {
    namespaces: graph.namespaces,
    entities: graph.entities.filter((e) => e.namespace === namespace),
    relations: graph.relations.filter((r) => r.namespace === namespace),
  };
}

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

  // The loaded entities and relations stored without a namespace member, keyed
  // like extraFields. A record is written with a namespace member, except one
  // of these: a write never adds a member to a record that was stored without
  // one, so that every record a write did not delete is kept as it was found.
  private legacyRecords = new WeakSet<object>();

  // A record's namespace member as saveGraph writes it.
  private namespaceMember(record: Entity | Relation): { namespace?: string } {
    return this.legacyRecords.has(record)
      ? {}
      : { namespace: record.namespace };
  }

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

  // The graph of one namespace, which must exist.
  private async loadNamespace(namespace: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    requireNamespace(graph, namespace);
    return inNamespace(graph, namespace);
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
      const graph: KnowledgeGraph = {
        namespaces: [],
        entities: [],
        relations: [],
      };
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
          const parsed = StoredEntitySchema.safeParse(item);
          if (parsed.success) {
            this.keepNamespaceMember(parsed.data, record);
            this.keepExtraFields(parsed.data, record, StoredEntitySchema.shape);
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
          const parsed = StoredRelationSchema.safeParse(item);
          if (parsed.success) {
            this.keepNamespaceMember(parsed.data, record);
            this.keepExtraFields(
              parsed.data,
              record,
              StoredRelationSchema.shape,
            );
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
        } else if (record.type === "namespace") {
          const parsed = NamespaceRecordSchema.safeParse(item);
          if (parsed.success) {
            this.keepExtraFields(
              parsed.data,
              record,
              NamespaceRecordSchema.shape,
            );
            graph.namespaces.push(parsed.data);
          } else {
            unreadable.push(line);
            console.error(
              "Skipping invalid namespace in memory file:",
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
        return {
          graph: { namespaces: [], entities: [], relations: [] },
          unreadable: [],
        };
      }
      throw error;
    }
  }

  // Note that a valid stored record had no namespace member, for namespaceMember.
  private keepNamespaceMember(
    parsed: object,
    record: Record<string, unknown>,
  ): void {
    if (!Object.hasOwn(record, "namespace")) {
      this.legacyRecords.add(parsed);
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
      ...graph.namespaces.map((n) =>
        JSON.stringify({
          type: "namespace",
          name: n.name,
          ...this.extraFields.get(n),
        }),
      ),
      ...graph.entities.map((e) =>
        JSON.stringify({
          type: "entity",
          ...this.namespaceMember(e),
          name: e.name,
          entityType: e.entityType,
          observations: e.observations,
          ...this.extraFields.get(e),
        }),
      ),
      ...graph.relations.map((r) =>
        JSON.stringify({
          type: "relation",
          ...this.namespaceMember(r),
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
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
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

  // Create a namespace. It fails if the name is taken, by a created namespace
  // or by records already stored under it, so that an existing namespace is
  // never taken over by mistake.
  async createNamespace(namespace: string): Promise<void> {
    return this.withLock(async () => {
      const { graph, unreadable } = await this.loadGraphWithUnreadable();
      if (namespaceExists(graph, namespace)) {
        throw new Error(`Namespace ${namespace} already exists`);
      }
      graph.namespaces.push({ name: namespace });
      await this.saveGraph(graph, unreadable);
    });
  }

  // Create the entities in namespace: each item is given the namespace, so the
  // items carry none of their own.
  async createEntities(
    namespace: string,
    entities: EntityInput[],
  ): Promise<Entity[]> {
    return this.withLock(async () => {
      const { graph, unreadable } = await this.loadGraphWithUnreadable();
      requireNamespace(graph, namespace);
      const newEntities: Entity[] = entities
        .filter(
          (e, index) =>
            !graph.entities.some(
              (existingEntity) =>
                existingEntity.namespace === namespace &&
                existingEntity.name === e.name,
            ) &&
            // Also skip duplicates appearing earlier in this same batch
            !entities
              .slice(0, index)
              .some((earlier) => earlier.name === e.name),
        )
        .map((e) => ({
          name: e.name,
          entityType: e.entityType,
          observations: e.observations,
          namespace,
        }));
      graph.entities.push(...newEntities);
      await this.saveGraph(graph, unreadable);
      return newEntities;
    });
  }

  async createRelations(
    namespace: string,
    relations: RelationInput[],
  ): Promise<Relation[]> {
    return this.withLock(async () => {
      const { graph, unreadable } = await this.loadGraphWithUnreadable();
      requireNamespace(graph, namespace);
      // A relation connects entities of its own namespace only.
      const entityNames = new Set(
        graph.entities
          .filter((e) => e.namespace === namespace)
          .map((e) => e.name),
      );

      relations.forEach((r) => {
        if (!entityNames.has(r.from)) {
          throw entityNotFound(r.from, namespace);
        }
        if (!entityNames.has(r.to)) {
          throw entityNotFound(r.to, namespace);
        }
      });

      const isSameRelation = (a: RelationInput, b: RelationInput) =>
        a.from === b.from && a.to === b.to && a.relationType === b.relationType;
      const newRelations: Relation[] = relations
        .filter(
          (r, index) =>
            !graph.relations.some(
              (existingRelation) =>
                existingRelation.namespace === namespace &&
                isSameRelation(existingRelation, r),
            ) &&
            // Also skip duplicates appearing earlier in this same batch
            !relations
              .slice(0, index)
              .some((earlier) => isSameRelation(earlier, r)),
        )
        .map((r) => ({
          from: r.from,
          to: r.to,
          relationType: r.relationType,
          namespace,
        }));
      graph.relations.push(...newRelations);
      await this.saveGraph(graph, unreadable);
      return newRelations;
    });
  }

  async addObservations(
    namespace: string,
    observations: { entityName: string; contents: string[] }[],
  ): Promise<{ entityName: string; addedObservations: string[] }[]> {
    return this.withLock(async () => {
      const { graph, unreadable } = await this.loadGraphWithUnreadable();
      requireNamespace(graph, namespace);
      const results = observations.map((o) => {
        const entity = graph.entities.find(
          (e) => e.namespace === namespace && e.name === o.entityName,
        );
        if (!entity) {
          throw entityNotFound(o.entityName, namespace);
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
    namespace: string,
    entityNames: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }> {
    return this.withLock(async () => {
      const { graph, unreadable } = await this.loadGraphWithUnreadable();
      requireNamespace(graph, namespace);
      const present = new Set(
        graph.entities
          .filter((e) => e.namespace === namespace)
          .map((e) => e.name),
      );
      const deleted = entityNames.filter((name) => present.has(name));
      const notFound = entityNames.filter((name) => !present.has(name));
      // Only this namespace's entities, and the relations among them, go: a
      // same-named entity elsewhere is a different entity.
      graph.entities = graph.entities.filter(
        (e) => e.namespace !== namespace || !entityNames.includes(e.name),
      );
      graph.relations = graph.relations.filter(
        (r) =>
          r.namespace !== namespace ||
          (!entityNames.includes(r.from) && !entityNames.includes(r.to)),
      );
      await this.saveGraph(graph, unreadable);
      return { deleted, notFound };
    });
  }

  async deleteObservations(
    namespace: string,
    deletions: { entityName: string; observations: string[] }[],
  ): Promise<{ deletedCount: number; missingEntities: string[] }> {
    return this.withLock(async () => {
      const { graph, unreadable } = await this.loadGraphWithUnreadable();
      requireNamespace(graph, namespace);
      let deletedCount = 0;
      const missingEntities: string[] = [];
      deletions.forEach((d) => {
        const entity = graph.entities.find(
          (e) => e.namespace === namespace && e.name === d.entityName,
        );
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
    namespace: string,
    relations: RelationInput[],
  ): Promise<{ deletedCount: number }> {
    return this.withLock(async () => {
      const { graph, unreadable } = await this.loadGraphWithUnreadable();
      requireNamespace(graph, namespace);
      const before = graph.relations.length;
      graph.relations = graph.relations.filter(
        (r) =>
          r.namespace !== namespace ||
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

  // Every namespace that exists, created or named by a stored record, with how
  // many entities and relations it holds (none, for a new one), in name order.
  async listNamespaces(): Promise<NamespaceSummary[]> {
    const graph = await this.loadGraph();
    const summaries = new Map<string, NamespaceSummary>();
    const summaryOf = (namespace: string): NamespaceSummary => {
      let summary = summaries.get(namespace);
      if (!summary) {
        summary = { namespace, entityCount: 0, relationCount: 0 };
        summaries.set(namespace, summary);
      }
      return summary;
    };
    graph.namespaces.forEach((n) => summaryOf(n.name));
    graph.entities.forEach((e) => summaryOf(e.namespace).entityCount++);
    graph.relations.forEach((r) => summaryOf(r.namespace).relationCount++);
    return [...summaries.values()].sort((a, b) =>
      a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0,
    );
  }

  // Move everything in namespace to newNamespace. It fails rather than merge
  // into a namespace that exists, since the two could hold entities of one
  // name. The records are changed in place, so their stored extras (see
  // extraFields) move with them.
  async renameNamespace(
    namespace: string,
    newNamespace: string,
  ): Promise<{ entityCount: number; relationCount: number }> {
    return this.withLock(async () => {
      if (namespace === newNamespace) {
        throw new Error(
          `The new namespace ${newNamespace} is the same as the current one`,
        );
      }
      const { graph, unreadable } = await this.loadGraphWithUnreadable();
      requireNamespace(graph, namespace);
      if (namespaceExists(graph, newNamespace)) {
        throw new Error(
          `Namespace ${newNamespace} already exists; namespaces are not merged, so delete it or choose another name`,
        );
      }
      const entities = graph.entities.filter((e) => e.namespace === namespace);
      const relations = graph.relations.filter(
        (r) => r.namespace === namespace,
      );
      graph.namespaces
        .filter((n) => n.name === namespace)
        .forEach((n) => (n.name = newNamespace));
      // The rename rewrites these records anyway, so they take the current
      // form, with a namespace member.
      [...entities, ...relations].forEach((record) => {
        record.namespace = newNamespace;
        this.legacyRecords.delete(record);
      });
      await this.saveGraph(graph, unreadable);
      return {
        entityCount: entities.length,
        relationCount: relations.length,
      };
    });
  }

  // Remove a namespace with every entity and relation in it. A namespace that
  // does not exist is not an error: the counts are 0, as for delete_entities.
  async deleteNamespace(
    namespace: string,
  ): Promise<{ entityCount: number; relationCount: number }> {
    return this.withLock(async () => {
      const { graph, unreadable } = await this.loadGraphWithUnreadable();
      const entityCount = graph.entities.filter(
        (e) => e.namespace === namespace,
      ).length;
      const relationCount = graph.relations.filter(
        (r) => r.namespace === namespace,
      ).length;
      graph.namespaces = graph.namespaces.filter((n) => n.name !== namespace);
      graph.entities = graph.entities.filter((e) => e.namespace !== namespace);
      graph.relations = graph.relations.filter(
        (r) => r.namespace !== namespace,
      );
      await this.saveGraph(graph, unreadable);
      return { entityCount, relationCount };
    });
  }

  // Every entity and relation of every namespace, as the knowledge-graph
  // resource serves it. Each record carries its namespace.
  async readFullGraph(): Promise<ReadGraphResult> {
    const graph = await this.loadGraph();
    return { entities: graph.entities, relations: graph.relations };
  }

  // The graph of one namespace, which must exist. entityTypes keeps only
  // entities of those types, and the relations that touch one of them;
  // observationLimit caps each entity's observations (see limitObservations).
  async readGraph(
    namespace: string,
    options: ReadGraphOptions = {},
  ): Promise<ReadGraphResult> {
    const graph = await this.loadNamespace(namespace);
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
    namespace: string,
    query: string,
    options: SearchNodesOptions = {},
  ): Promise<ReadGraphResult> {
    const graph = await this.loadNamespace(namespace);

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
    namespace: string,
    names: string[],
    options: OpenNodesOptions = {},
  ): Promise<ReadGraphResult> {
    const graph = await this.loadNamespace(namespace);

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
      description:
        "The full knowledge graph with all entities and relations, in every namespace",
      mimeType: "application/json",
    },
    async (uri) => {
      const graph = await manager.readFullGraph();
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
    namespace: e.namespace,
    observationCount: e.observations.length,
  }));
}
