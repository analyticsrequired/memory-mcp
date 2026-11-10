// Tests for namespaces, driven through an SDK Client over an in-memory
// transport. Every entity and relation belongs to one namespace; an entity is
// identified by its namespace and name together, and a relation connects
// entities of its own namespace only. Namespaces are explicit: create_namespace
// makes one, every other tool names the namespace to work in and fails if it
// does not exist, and there is no default. A call names its namespace once, and
// the server applies it to the entities and relations in the call.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import {
  call,
  connect,
  inNs,
  makeTempGraph,
  readFileText,
  textOf,
  Connection,
} from "./helpers.js";

const alice = {
  name: "Alice",
  entityType: "person",
  observations: ["works at Acme"],
};
const bob = { name: "Bob", entityType: "person", observations: ["likes tea"] };
const aliceKnowsBob = { from: "Alice", to: "Bob", relationType: "knows" };

const missing = (namespace: string) =>
  `Namespace ${namespace} does not exist; create it with create_namespace, or list the existing ones with list_namespaces`;

describe("namespaces over the protocol", () => {
  let conn: Connection;
  let client: Connection["client"];
  let filePath: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const graph = await makeTempGraph();
    filePath = graph.filePath;
    cleanup = graph.cleanup;
    conn = await connect(filePath);
    client = conn.client;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await conn.close();
    await cleanup();
  });

  const create = (namespace: string) =>
    call(client, "create_namespace", { namespace });

  const read = async (namespace: string) =>
    (await call(client, "read_graph", { namespace })).structuredContent;

  const list = async () =>
    (await call(client, "list_namespaces")).structuredContent;

  const empty = { entities: [], relations: [] };

  // The graph file, one parsed record per line.
  async function records(): Promise<unknown[]> {
    return (await readFileText(filePath))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as unknown);
  }

  // An error result's text.
  function errorText(result: Awaited<ReturnType<typeof call>>): string {
    expect(result.isError).toBe(true);
    return textOf(result);
  }

  describe("create_namespace", () => {
    it("creates an empty namespace that list_namespaces shows", async () => {
      const result = await create("story");

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({
        success: true,
        message: "Created namespace story",
      });
      expect(textOf(result)).toBe("Created namespace story");
      expect(await list()).toEqual({
        namespaces: [{ namespace: "story", entityCount: 0, relationCount: 0 }],
      });
      expect(await read("story")).toEqual(empty);
    });

    it("fails for a namespace that already exists", async () => {
      await create("story");

      const again = await create("story");

      expect(errorText(again)).toBe("Namespace story already exists");
      expect(await list()).toEqual({
        namespaces: [{ namespace: "story", entityCount: 0, relationCount: 0 }],
      });
    });

    it("fails for a namespace that exists only because records name it", async () => {
      await fs.writeFile(
        filePath,
        '{"type":"entity","namespace":"a","name":"X","entityType":"t","observations":[]}\n',
      );

      expect(errorText(await create("a"))).toBe("Namespace a already exists");
    });

    it("is case-sensitive", async () => {
      await create("Story");
      expect((await create("story")).isError).toBeUndefined();
      expect(await list()).toEqual({
        namespaces: [
          { namespace: "Story", entityCount: 0, relationCount: 0 },
          { namespace: "story", entityCount: 0, relationCount: 0 },
        ],
      });
    });

    it("rejects an empty name, and accepts 256 characters but not 257", async () => {
      expect((await create("")).isError).toBe(true);
      expect((await create("x".repeat(256))).isError).toBeUndefined();
      expect((await create("x".repeat(257))).isError).toBe(true);
    });

    it("requires a namespace", async () => {
      const result = await call(client, "create_namespace", {});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/namespace/);
    });
  });

  describe("a required, existing namespace", () => {
    const writes: [string, Record<string, unknown>][] = [
      ["create_entities", { entities: [alice] }],
      ["create_relations", { relations: [aliceKnowsBob] }],
      [
        "add_observations",
        { observations: [{ entityName: "Alice", contents: ["x"] }] },
      ],
      ["delete_entities", { entityNames: ["Alice"] }],
      [
        "delete_observations",
        { deletions: [{ entityName: "Alice", observations: ["x"] }] },
      ],
      ["delete_relations", { relations: [aliceKnowsBob] }],
    ];
    const reads: [string, Record<string, unknown>][] = [
      ["read_graph", {}],
      ["search_nodes", { query: "a" }],
      ["open_nodes", { names: ["Alice"] }],
    ];

    it.each([...writes, ...reads])(
      "makes %s fail when no namespace is given",
      async (name, args) => {
        const result = await call(client, name, args);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/namespace/);
        await expect(fs.access(filePath)).rejects.toThrow();
      },
    );

    it.each([...writes, ...reads])(
      "makes %s fail for a namespace that does not exist, writing nothing",
      async (name, args) => {
        const result = await call(client, name, { namespace: "nope", ...args });

        expect(errorText(result)).toBe(missing("nope"));
        await expect(fs.access(filePath)).rejects.toThrow();
      },
    );

    it("does not create a namespace as a side effect of a write", async () => {
      await call(client, "create_entities", {
        namespace: "nope",
        entities: [alice],
      });

      expect(await list()).toEqual({ namespaces: [] });
    });

    it("does not fall back to a namespace called default", async () => {
      await create("default");
      await call(client, "create_entities", {
        namespace: "default",
        entities: [alice],
      });

      const result = await call(client, "read_graph", {});

      expect(result.isError).toBe(true);
    });

    it("rejects an empty namespace", async () => {
      const result = await call(client, "read_graph", { namespace: "" });
      expect(result.isError).toBe(true);
    });

    it("matches a namespace exactly, case included", async () => {
      await create("Story");
      expect(
        errorText(await call(client, "read_graph", { namespace: "story" })),
      ).toBe(missing("story"));
    });
  });

  describe("entities and relations are given the call's namespace", () => {
    beforeEach(async () => {
      await create("a");
      await create("b");
    });

    it("returns created entities and relations carrying the namespace", async () => {
      const entities = await call(client, "create_entities", {
        namespace: "a",
        entities: [alice, bob],
      });
      const relations = await call(client, "create_relations", {
        namespace: "a",
        relations: [aliceKnowsBob],
      });

      expect(entities.structuredContent).toEqual({
        entities: [inNs(alice, "a"), inNs(bob, "a")],
      });
      expect(relations.structuredContent).toEqual({
        relations: [inNs(aliceKnowsBob, "a")],
      });
    });

    it("ignores a namespace written on an item: the call's namespace decides", async () => {
      const result = await call(client, "create_entities", {
        namespace: "a",
        entities: [{ ...alice, namespace: "b" }],
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({
        entities: [inNs(alice, "a")],
      });
      expect(await read("b")).toEqual(empty);
    });

    it("keeps the same entity name in two namespaces", async () => {
      const inA = { ...alice, observations: ["in a"] };
      const inB = { ...alice, observations: ["in b"] };

      const first = await call(client, "create_entities", {
        namespace: "a",
        entities: [inA],
      });
      const second = await call(client, "create_entities", {
        namespace: "b",
        entities: [inB],
      });

      // The second Alice is new in its namespace, so nothing is skipped.
      expect(first.structuredContent).toEqual({ entities: [inNs(inA, "a")] });
      expect(second.structuredContent).toEqual({ entities: [inNs(inB, "b")] });
      expect(await read("a")).toEqual({
        entities: [inNs(inA, "a")],
        relations: [],
      });
      expect(await read("b")).toEqual({
        entities: [inNs(inB, "b")],
        relations: [],
      });
    });

    it("scopes relations to their namespace", async () => {
      for (const namespace of ["a", "b"]) {
        await call(client, "create_entities", {
          namespace,
          entities: [alice, bob],
        });
      }
      await call(client, "create_relations", {
        namespace: "a",
        relations: [aliceKnowsBob],
      });

      expect(await read("a")).toEqual({
        entities: [inNs(alice, "a"), inNs(bob, "a")],
        relations: [inNs(aliceKnowsBob, "a")],
      });
      expect(await read("b")).toEqual({
        entities: [inNs(alice, "b"), inNs(bob, "b")],
        relations: [],
      });
    });

    it("cannot relate an entity to one in another namespace", async () => {
      await call(client, "create_entities", {
        namespace: "a",
        entities: [alice],
      });
      await call(client, "create_entities", {
        namespace: "b",
        entities: [bob],
      });

      const result = await call(client, "create_relations", {
        namespace: "a",
        relations: [aliceKnowsBob],
      });

      expect(errorText(result)).toBe(
        "Entity with name Bob not found in namespace a",
      );
      expect(await read("a")).toEqual({
        entities: [inNs(alice, "a")],
        relations: [],
      });
    });

    it("deletes entities, and the relations among them, in the named namespace only", async () => {
      for (const namespace of ["a", "b"]) {
        await call(client, "create_entities", {
          namespace,
          entities: [alice, bob],
        });
        await call(client, "create_relations", {
          namespace,
          relations: [aliceKnowsBob],
        });
      }

      await call(client, "delete_entities", {
        namespace: "a",
        entityNames: ["Alice"],
      });

      expect(await read("a")).toEqual({
        entities: [inNs(bob, "a")],
        relations: [],
      });
      expect(await read("b")).toEqual({
        entities: [inNs(alice, "b"), inNs(bob, "b")],
        relations: [inNs(aliceKnowsBob, "b")],
      });
    });

    it("deletes relations in the named namespace only", async () => {
      for (const namespace of ["a", "b"]) {
        await call(client, "create_entities", {
          namespace,
          entities: [alice, bob],
        });
        await call(client, "create_relations", {
          namespace,
          relations: [aliceKnowsBob],
        });
      }

      await call(client, "delete_relations", {
        namespace: "a",
        relations: [aliceKnowsBob],
      });

      expect(((await read("a")) as { relations: unknown[] }).relations).toEqual(
        [],
      );
      expect(((await read("b")) as { relations: unknown[] }).relations).toEqual(
        [inNs(aliceKnowsBob, "b")],
      );
    });

    it("adds and deletes observations in the named namespace only", async () => {
      for (const namespace of ["a", "b"]) {
        await call(client, "create_entities", {
          namespace,
          entities: [alice],
        });
      }

      const added = await call(client, "add_observations", {
        namespace: "a",
        observations: [{ entityName: "Alice", contents: ["new"] }],
      });
      expect(added.structuredContent).toEqual({
        results: [{ entityName: "Alice", addedObservations: ["new"] }],
      });
      await call(client, "delete_observations", {
        namespace: "b",
        deletions: [{ entityName: "Alice", observations: ["works at Acme"] }],
      });

      expect(await read("a")).toEqual({
        entities: [
          inNs({ ...alice, observations: ["works at Acme", "new"] }, "a"),
        ],
        relations: [],
      });
      expect(await read("b")).toEqual({
        entities: [inNs({ ...alice, observations: [] }, "b")],
        relations: [],
      });
    });

    it("reports an entity of another namespace as not found when adding observations", async () => {
      await call(client, "create_entities", {
        namespace: "a",
        entities: [alice],
      });

      const added = await call(client, "add_observations", {
        namespace: "b",
        observations: [{ entityName: "Alice", contents: ["x"] }],
      });

      expect(errorText(added)).toBe(
        "Entity with name Alice not found in namespace b",
      );
    });

    it("does not touch an entity of another namespace when deleting observations", async () => {
      await call(client, "create_entities", {
        namespace: "a",
        entities: [alice],
      });

      const removed = await call(client, "delete_observations", {
        namespace: "b",
        deletions: [{ entityName: "Alice", observations: ["works at Acme"] }],
      });

      expect(removed.isError).toBeUndefined();
      expect(await read("a")).toEqual({
        entities: [inNs(alice, "a")],
        relations: [],
      });
    });

    it("searches and opens nodes within the named namespace only", async () => {
      await call(client, "create_entities", {
        namespace: "a",
        entities: [alice, bob],
      });
      await call(client, "create_entities", {
        namespace: "b",
        entities: [alice],
      });
      await call(client, "create_relations", {
        namespace: "a",
        relations: [aliceKnowsBob],
      });

      const searched = await call(client, "search_nodes", {
        namespace: "a",
        query: "alice",
      });
      const opened = await call(client, "open_nodes", {
        namespace: "b",
        names: ["Alice", "Bob"],
      });

      expect(searched.structuredContent).toEqual({
        entities: [inNs(alice, "a")],
        relations: [inNs(aliceKnowsBob, "a")],
      });
      // Bob is only in a, so b opens just its own Alice.
      expect(opened.structuredContent).toEqual({
        entities: [inNs(alice, "b")],
        relations: [],
      });
    });

    it("keeps the namespace on entities when observationLimit trims them", async () => {
      await call(client, "create_entities", {
        namespace: "a",
        entities: [alice],
      });

      const result = await call(client, "read_graph", {
        namespace: "a",
        observationLimit: 0,
      });

      expect(result.structuredContent).toEqual({
        entities: [
          { ...inNs({ ...alice, observations: [] }, "a"), observationCount: 1 },
        ],
        relations: [],
      });
    });
  });

  describe("list_namespaces", () => {
    it("lists nothing for a new graph", async () => {
      expect(await list()).toEqual({ namespaces: [] });
    });

    it("counts each namespace's entities and relations, in name order, empty ones included", async () => {
      await create("b");
      await create("a");
      await create("c");
      await call(client, "create_entities", {
        namespace: "b",
        entities: [alice, bob],
      });
      await call(client, "create_relations", {
        namespace: "b",
        relations: [aliceKnowsBob],
      });
      await call(client, "create_entities", {
        namespace: "a",
        entities: [alice],
      });

      expect(await list()).toEqual({
        namespaces: [
          { namespace: "a", entityCount: 1, relationCount: 0 },
          { namespace: "b", entityCount: 2, relationCount: 1 },
          { namespace: "c", entityCount: 0, relationCount: 0 },
        ],
      });
    });

    it("keeps listing a namespace after everything in it is deleted", async () => {
      await create("a");
      await call(client, "create_entities", {
        namespace: "a",
        entities: [alice],
      });
      await call(client, "delete_entities", {
        namespace: "a",
        entityNames: ["Alice"],
      });

      expect(await list()).toEqual({
        namespaces: [{ namespace: "a", entityCount: 0, relationCount: 0 }],
      });
    });
  });

  describe("rename_namespace", () => {
    beforeEach(async () => {
      await create("a");
      await call(client, "create_entities", {
        namespace: "a",
        entities: [alice, bob],
      });
      await call(client, "create_relations", {
        namespace: "a",
        relations: [aliceKnowsBob],
      });
    });

    it("moves every entity and relation to the new name", async () => {
      const result = await call(client, "rename_namespace", {
        namespace: "a",
        newNamespace: "b",
      });

      expect(result.structuredContent).toEqual({
        success: true,
        message: "Renamed namespace a to b: moved 2 entities and 1 relation",
        entityCount: 2,
        relationCount: 1,
      });
      expect(await read("b")).toEqual({
        entities: [inNs(alice, "b"), inNs(bob, "b")],
        relations: [inNs(aliceKnowsBob, "b")],
      });
      expect(
        errorText(await call(client, "read_graph", { namespace: "a" })),
      ).toBe(missing("a"));
    });

    it("renames an empty namespace", async () => {
      await create("empty");

      const result = await call(client, "rename_namespace", {
        namespace: "empty",
        newNamespace: "renamed",
      });

      expect(textOf(result)).toBe(
        "Renamed namespace empty to renamed: moved 0 entities and 0 relations",
      );
      expect(await list()).toEqual({
        namespaces: [
          { namespace: "a", entityCount: 2, relationCount: 1 },
          { namespace: "renamed", entityCount: 0, relationCount: 0 },
        ],
      });
    });

    it("words one entity and no relations in the singular and plural", async () => {
      await create("solo");
      await call(client, "create_entities", {
        namespace: "solo",
        entities: [alice],
      });

      const result = await call(client, "rename_namespace", {
        namespace: "solo",
        newNamespace: "one",
      });

      expect(textOf(result)).toBe(
        "Renamed namespace solo to one: moved 1 entity and 0 relations",
      );
    });

    it("fails for a namespace that does not exist", async () => {
      const result = await call(client, "rename_namespace", {
        namespace: "nope",
        newNamespace: "b",
      });

      expect(errorText(result)).toBe(missing("nope"));
    });

    it("fails rather than merge into a namespace that exists, even an empty one", async () => {
      await create("b");

      const result = await call(client, "rename_namespace", {
        namespace: "a",
        newNamespace: "b",
      });

      expect(errorText(result)).toBe(
        "Namespace b already exists; namespaces are not merged, so delete it or choose another name",
      );
      expect(
        ((await read("a")) as { entities: unknown[] }).entities,
      ).toHaveLength(2);
    });

    it("fails when the new name is the current one", async () => {
      const result = await call(client, "rename_namespace", {
        namespace: "a",
        newNamespace: "a",
      });

      expect(errorText(result)).toBe(
        "The new namespace a is the same as the current one",
      );
    });

    it("requires both names", async () => {
      const noNew = await call(client, "rename_namespace", { namespace: "a" });
      const noOld = await call(client, "rename_namespace", {
        newNamespace: "b",
      });

      expect(noNew.isError).toBe(true);
      expect(noOld.isError).toBe(true);
    });
  });

  describe("delete_namespace", () => {
    beforeEach(async () => {
      await create("a");
      await create("b");
      for (const namespace of ["a", "b"]) {
        await call(client, "create_entities", {
          namespace,
          entities: [alice, bob],
        });
        await call(client, "create_relations", {
          namespace,
          relations: [aliceKnowsBob],
        });
      }
    });

    it("deletes the namespace with everything in it and reports how much", async () => {
      const result = await call(client, "delete_namespace", {
        namespace: "a",
      });

      expect(result.structuredContent).toEqual({
        success: true,
        message: "Deleted namespace a: 2 entities and 1 relation",
        entityCount: 2,
        relationCount: 1,
      });
      expect(await list()).toEqual({
        namespaces: [{ namespace: "b", entityCount: 2, relationCount: 1 }],
      });
      expect(
        errorText(await call(client, "read_graph", { namespace: "a" })),
      ).toBe(missing("a"));
    });

    it("deletes an empty namespace", async () => {
      await create("empty");

      const result = await call(client, "delete_namespace", {
        namespace: "empty",
      });

      // An empty namespace existed, but there was nothing in it to count.
      expect(result.isError).toBeUndefined();
      expect(await list()).toEqual({
        namespaces: [
          { namespace: "a", entityCount: 2, relationCount: 1 },
          { namespace: "b", entityCount: 2, relationCount: 1 },
        ],
      });
    });

    it("is not an error for a namespace that does not exist, and is idempotent", async () => {
      const first = await call(client, "delete_namespace", { namespace: "a" });
      const again = await call(client, "delete_namespace", { namespace: "a" });

      expect(first.isError).toBeUndefined();
      expect(again.isError).toBeUndefined();
      expect(again.structuredContent).toEqual({
        success: true,
        message:
          "Namespace a does not exist or holds nothing, so nothing was deleted",
        entityCount: 0,
        relationCount: 0,
      });
    });

    it("words one entity and no relations in the singular and plural", async () => {
      await create("solo");
      await call(client, "create_entities", {
        namespace: "solo",
        entities: [alice],
      });

      const result = await call(client, "delete_namespace", {
        namespace: "solo",
      });

      expect(textOf(result)).toBe(
        "Deleted namespace solo: 1 entity and 0 relations",
      );
    });

    it("requires the name, and never deletes anything without it", async () => {
      const result = await call(client, "delete_namespace", {});

      expect(result.isError).toBe(true);
      expect(await list()).toEqual({
        namespaces: [
          { namespace: "a", entityCount: 2, relationCount: 1 },
          { namespace: "b", entityCount: 2, relationCount: 1 },
        ],
      });
    });
  });

  describe("the knowledge-graph resource", () => {
    it("serves the entities and relations of every namespace", async () => {
      await create("empty");
      await create("one");
      await create("a");
      await call(client, "create_entities", {
        namespace: "one",
        entities: [alice],
      });
      await call(client, "create_entities", {
        namespace: "a",
        entities: [alice, bob],
      });
      await call(client, "create_relations", {
        namespace: "a",
        relations: [aliceKnowsBob],
      });

      const { contents } = await client.readResource({
        uri: "memory://knowledge-graph",
      });

      const [content] = contents;
      expect("text" in content && JSON.parse(content.text)).toEqual({
        entities: [inNs(alice, "one"), inNs(alice, "a"), inNs(bob, "a")],
        relations: [inNs(aliceKnowsBob, "a")],
      });
    });
  });

  describe("storage", () => {
    it("writes namespace records first, then entities and relations with a namespace member", async () => {
      await create("a");
      await call(client, "create_entities", {
        namespace: "a",
        entities: [bob],
      });
      await call(client, "create_relations", {
        namespace: "a",
        relations: [{ from: "Bob", to: "Bob", relationType: "knows" }],
      });
      await create("empty");

      expect(await readFileText(filePath)).toBe(
        [
          '{"type":"namespace","name":"a"}',
          '{"type":"namespace","name":"empty"}',
          '{"type":"entity","namespace":"a","name":"Bob","entityType":"person","observations":["likes tea"]}',
          '{"type":"relation","namespace":"a","from":"Bob","to":"Bob","relationType":"knows"}',
          "",
        ].join("\n"),
      );
    });

    it("treats an entity or relation with no namespace as unreadable, and keeps its line", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const entity =
        '{"type":"entity","name":"Alice","entityType":"person","observations":[]}';
      const relation =
        '{"type":"relation","from":"Alice","to":"Alice","relationType":"is"}';
      await fs.writeFile(filePath, `${entity}\n${relation}\n`);

      // Nothing falls back to a namespace for these, so they are in none.
      expect(await list()).toEqual({ namespaces: [] });

      await create("a");
      expect((await readFileText(filePath)).split("\n")).toEqual([
        '{"type":"namespace","name":"a"}',
        entity,
        relation,
        "",
      ]);
    });

    it("keeps unmodelled fields when rename_namespace moves a record", async () => {
      await fs.writeFile(
        filePath,
        '{"type":"entity","namespace":"a","name":"Alice","entityType":"person","observations":[],"createdAt":"2025-01-01"}\n' +
          '{"type":"relation","namespace":"a","from":"Alice","to":"Alice","relationType":"is","weight":2}\n',
      );

      await call(client, "rename_namespace", {
        namespace: "a",
        newNamespace: "b",
      });

      expect(await readFileText(filePath)).toBe(
        '{"type":"entity","namespace":"b","name":"Alice","entityType":"person","observations":[],"createdAt":"2025-01-01"}\n' +
          '{"type":"relation","namespace":"b","from":"Alice","to":"Alice","relationType":"is","weight":2}\n',
      );
    });

    it("renames the namespace record with its records, and keeps its unmodelled fields", async () => {
      await fs.writeFile(
        filePath,
        '{"type":"namespace","name":"a","description":"kept"}\n',
      );

      await call(client, "rename_namespace", {
        namespace: "a",
        newNamespace: "b",
      });

      expect(await records()).toEqual([
        { type: "namespace", name: "b", description: "kept" },
      ]);
    });

    it("treats a namespace record with no name as unreadable, and keeps its line", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const bad = '{"type":"namespace","name":""}';
      await fs.writeFile(filePath, `${bad}\n`);

      expect(await list()).toEqual({ namespaces: [] });
      await create("a");
      expect((await readFileText(filePath)).split("\n")).toEqual([
        '{"type":"namespace","name":"a"}',
        bad,
        "",
      ]);
    });

    it("treats a record with an invalid namespace as unreadable, and keeps its line", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const badType =
        '{"type":"entity","namespace":5,"name":"X","entityType":"t","observations":[]}';
      const badEmpty =
        '{"type":"relation","namespace":"","from":"X","to":"X","relationType":"is"}';
      await fs.writeFile(filePath, `${badType}\n${badEmpty}\n`);

      expect(await list()).toEqual({ namespaces: [] });

      await create("a");
      await call(client, "create_entities", {
        namespace: "a",
        entities: [alice],
      });
      expect((await readFileText(filePath)).split("\n")).toEqual([
        '{"type":"namespace","name":"a"}',
        '{"type":"entity","namespace":"a","name":"Alice","entityType":"person","observations":["works at Acme"]}',
        badType,
        badEmpty,
        "",
      ]);
    });

    it("counts a namespace that holds only relations, and can rename or delete it", async () => {
      // Not reachable through the tools, but a hand-edited file can hold it.
      await fs.writeFile(
        filePath,
        '{"type":"relation","namespace":"r","from":"A","to":"B","relationType":"is"}\n',
      );

      expect(await list()).toEqual({
        namespaces: [{ namespace: "r", entityCount: 0, relationCount: 1 }],
      });
      const renamed = await call(client, "rename_namespace", {
        namespace: "r",
        newNamespace: "s",
      });
      expect(textOf(renamed)).toBe(
        "Renamed namespace r to s: moved 0 entities and 1 relation",
      );
      const deleted = await call(client, "delete_namespace", {
        namespace: "s",
      });
      expect(textOf(deleted)).toBe(
        "Deleted namespace s: 0 entities and 1 relation",
      );
    });
  });
});
