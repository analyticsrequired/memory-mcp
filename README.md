# memory-mcp

A basic implementation of persistent, namespaced memory using a local knowledge graph. This lets agent harnesses remember information across chats.

This is a fork of: https://github.com/modelcontextprotocol/servers/tree/main/src/memory

## Core Concepts

### Entities

Entities are the primary nodes in the knowledge graph. Each entity has:

- A name that identifies it within its namespace
- An entity type (e.g., "person", "organization", "event")
- A list of observations
- A namespace (see [Namespaces](#namespaces)), which the server sets from the `namespace` input of the call that creates the entity

Example:

```json
{
  "name": "John_Smith",
  "entityType": "person",
  "observations": ["Speaks fluent Spanish"],
  "namespace": "default"
}
```

### Relations

Relations define directed connections between entities of the same namespace. They are always stored in active voice and describe how entities interact or relate to each other. A relation has the namespace of the entities it connects, set from the call that creates it.

Example:

```json
{
  "from": "John_Smith",
  "to": "Anthropic",
  "relationType": "works_at",
  "namespace": "default"
}
```

### Observations

Observations are discrete pieces of information about an entity. They are:

- Stored as strings
- Attached to specific entities
- Can be added or removed independently
- Should be atomic (one fact per observation)

Example:

```json
{
  "entityName": "John_Smith",
  "observations": [
    "Speaks fluent Spanish",
    "Graduated in 2019",
    "Prefers morning meetings"
  ]
}
```

### Namespaces

A namespace keeps one set of entities and relations apart from another in the same memory file, for example one per project, story or user. Every entity and relation belongs to exactly one namespace.

- **Isolation.** An entity is identified by its namespace and name together, so `Alice` can exist in several namespaces as different entities. A relation connects entities of its own namespace only; relating to an entity that exists only in another namespace fails as not found.
- **Explicit, with no default.** Every tool that works inside a namespace requires a `namespace` input, and the model has to name one on every call. There is no default namespace and an omitted `namespace` is a validation error, never a fallback.
- **Namespaces are created, not implied.** `create_namespace` makes one; every other tool fails with an error that points at `create_namespace` and `list_namespaces` if the namespace it names does not exist, for reads as well as writes. A write never creates a namespace as a side effect, so a misspelled name is caught instead of silently starting a second graph. `create_namespace` fails if the namespace already exists, which tells the model to reuse it. A namespace stays until `delete_namespace`, even when it is empty.
- **One namespace per call, applied by the server.** A call names its namespace once. The `entities`, `relations`, `observations` and `deletions` in it are `Omit<Entity, "namespace">` and the like: they have no `namespace` of their own, and the server puts the call's namespace on each entity and relation it creates. The entities and relations a tool returns do carry their `namespace`. A `namespace` member written on an input item is not part of the schema and is ignored, so the call's `namespace` always decides.
- **Names.** A namespace is a case-sensitive string of 1 to 256 characters, matched exactly.
- **Reads stay inside one namespace.** `read_graph`, `search_nodes` and `open_nodes` read the namespace they are given; there is no way to read "all of them" through a tool. The [knowledge-graph resource](#resources) is the one place that serves every namespace.
- **Whole namespaces.** `rename_namespace` and `delete_namespace` act on a namespace and everything in it at once. Renaming never merges into an existing namespace.

In the memory file, each namespace is a `{"type":"namespace","name":…}` line, written before the entities and relations, and every entity and relation line carries a `namespace` member. A file written before namespaces existed (records with no `namespace`) is read as the single namespace `default`, which then exists like any other and can be used, renamed or deleted; records read this way are written back exactly as they were until they are changed, and everything the server writes new has the member. A record whose `namespace` is not a non-empty string, or a namespace line with no valid `name`, is treated like any other unreadable line: it is skipped and written back unchanged.

## API

### Tools

Every tool except the namespace-management tools (`create_namespace`, `list_namespaces`, `rename_namespace`, `delete_namespace`) takes a required `namespace` input (a string of 1 to 256 characters, naming a namespace that exists) and works only inside that namespace; see [Namespaces](#namespaces). It is not repeated in each tool below. The entities and relations a tool returns carry their `namespace`; the ones a tool takes do not.

- **create_entities**
  - Create multiple new entities in the knowledge graph
  - Input: `entities` (array of objects)
    - Each object contains:
      - `name` (string): Entity identifier
      - `entityType` (string): Type classification
      - `observations` (string[]): Associated observations
  - Ignores entities whose name already exists in the namespace (and repeats of a name earlier in the same call); their observations are not added. The same name in another namespace is a different entity
  - Returns the created entities. When any were skipped, the structured result also lists their names in `skipped`, and a second text item says which were skipped (use `add_observations` to extend an existing entity)

- **create_relations**
  - Create multiple new relations between entities
  - Input: `relations` (array of objects)
    - Each object contains:
      - `from` (string): Source entity name
      - `to` (string): Target entity name
      - `relationType` (string): Relationship type in active voice
  - Skips duplicate relations
  - Fails if either the source or target entity doesn't exist in the namespace; the error names the namespace

- **add_observations**
  - Add new observations to existing entities
  - Input: `observations` (array of objects)
    - Each object contains:
      - `entityName` (string): Target entity
      - `contents` (string[]): New observations to add
  - Returns added observations per entity
  - Fails if entity doesn't exist in the namespace

- **delete_entities**
  - Remove entities and their relations
  - Input: `entityNames` (string[])
  - Cascading deletion of associated relations, within the namespace
  - No error if an entity doesn't exist in the namespace; the response reports which names were not found

- **delete_observations**
  - Remove specific observations from entities
  - Input: `deletions` (array of objects)
    - Each object contains:
      - `entityName` (string): Target entity
      - `observations` (string[]): Observations to remove
  - No error if an observation doesn't exist; the response reports how many were deleted

- **delete_relations**
  - Remove specific relations from the graph
  - Input: `relations` (array of objects)
    - Each object contains:
      - `from` (string): Source entity name
      - `to` (string): Target entity name
      - `relationType` (string): Relationship type
  - No error if a relation doesn't exist; the response reports how many were deleted

- **read_graph**
  - Read the entire knowledge graph of one namespace
  - Optional input:
    - `entityTypes` (string[], at least one): return only entities of these types, and the relations that touch one of them
    - `observationLimit` (integer, 0 or more): see below
  - Returns complete graph structure with all entities and relations of the namespace
  - With `observationLimit`, each entity carries at most that many observations (the first ones, in the order they were added) and an `observationCount` with its total. `observationLimit: 0` returns names, types and counts only: a cheap overview of a large graph, from which `open_nodes` reads the entities you need in full

- **search_nodes**
  - Search for nodes based on query
  - Input: `query` (string, at most 2048 characters; a longer query is rejected)
  - Searches across:
    - Entity names
    - Entity types
    - Observation content
  - Returns matching entities and their relations
  - Optional input:
    - `limit` (integer, 1 or more): return at most this many matches (the first, in stored order), with the relations that touch them
    - `observationLimit` (integer, 0 or more): as for `read_graph`

- **open_nodes**
  - Retrieve specific nodes by name
  - Input: `names` (string[])
  - Returns:
    - Requested entities
    - Relations between requested entities
  - Silently skips non-existent nodes
  - Optional input: `observationLimit` (integer, 0 or more), as for `read_graph`

- **create_namespace**
  - Create a namespace, where entities and relations live
  - Input: `namespace` (string, required): the name to create
  - Fails if the namespace already exists, so the model reuses it (see `list_namespaces`) instead of creating it again

- **list_namespaces**
  - List every namespace, empty ones included
  - Input: none
  - Returns each namespace with its `entityCount` and `relationCount`, in name order; a new graph has none

- **rename_namespace**
  - Move every entity and relation of a namespace to a new name
  - Input: `namespace` (string, required): the current name; `newNamespace` (string, required): the new name
  - Fails if the namespace does not exist, if the new name is the current one, or if the new name already exists: namespaces are never merged, so delete the target or choose another name
  - Returns how many entities and relations moved

- **delete_namespace**
  - Delete a namespace with every entity and relation in it; this cannot be undone
  - Input: `namespace` (string, required)
  - No error if the namespace does not exist; the response reports 0 deleted
  - Returns how many entities and relations were deleted

### Resources

- **knowledge-graph** (`memory://knowledge-graph`)
  - The full knowledge graph as a readable MCP Resource
  - MIME type: `application/json`
  - Returns the same shape as `read_graph` (entities and relations), but for every namespace at once: each entity and relation carries its `namespace`. A namespace with nothing in it shows up only in `list_namespaces`
  - Mutation tools (`create_entities`, `create_relations`, `add_observations`, `delete_entities`, `delete_observations`, `delete_relations`, `create_namespace`, `rename_namespace`, `delete_namespace`) emit `notifications/resources/updated` for this URI, so subscribed clients see live changes
  - How a client subscribes depends on its protocol version: a 2026-07-28 client names the URI in the `resourceSubscriptions` of its `subscriptions/listen` request and gets the updates on that stream; a 2025-era client calls `resources/subscribe`

## Protocol versions

The server serves both protocol eras on stdio from the same process. The client's first message picks the era of the connection: a 2026-07-28 client opens with `server/discover` and sends its protocol version, identity and capabilities with each request, and a 2025-era client opens with the `initialize` handshake. The tools and the resource are the same on both.

## Requirements

Node.js 24 or later, when the server runs through `npx` or from source.

# Usage with Claude Desktop

### Setup

Add this to your claude_desktop_config.json:

#### Docker

```json
{
  "mcpServers": {
    "memory": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "-v",
        "claude-memory:/app/dist",
        "--rm",
        "mcp/memory"
      ]
    }
  }
}
```

#### NPX

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@analyticsrequired/memory-mcp"]
    }
  }
}
```

On Windows, use `cmd /c` to launch `npx`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@analyticsrequired/memory-mcp"]
    }
  }
}
```

#### NPX with custom setting

The server can be configured using the following environment variables:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@analyticsrequired/memory-mcp"],
      "env": {
        "MEMORY_FILE_PATH": "/path/to/custom/memory.jsonl"
      }
    }
  }
}
```

On Windows, use:

```json
{
  "mcpServers": {
    "memory": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@analyticsrequired/memory-mcp"],
      "env": {
        "MEMORY_FILE_PATH": "/path/to/custom/memory.jsonl"
      }
    }
  }
}
```

- `MEMORY_FILE_PATH`: Path to the memory storage JSONL file (default: `memory.jsonl` in the server directory). A leading `~` expands to your home directory; a relative path resolves against the server directory. Set it to an absolute path you own; see [Choosing where the graph is stored](#choosing-where-the-graph-is-stored).

When `MEMORY_FILE_PATH` is not set and the server directory still holds a legacy `memory.json` but no `memory.jsonl`, the server renames `memory.json` to `memory.jsonl` at startup. If that rename fails, the server exits with an error naming both paths and the cause, rather than starting on an empty graph; fix the cause (a permission problem, say) and restart, or set `MEMORY_FILE_PATH` to choose a file explicitly.

#### Choosing where the graph is stored

**Set `MEMORY_FILE_PATH` to an absolute path you own**, such as `~/memory.jsonl`, as in the configuration above. The default `memory.jsonl` sits in the server's own directory, next to its code. Under `npx` or an npm install, that directory is inside a `node_modules` tree, which npm manages as its own: reinstalling or updating the server, or clearing the npx cache, can delete the file and the knowledge graph in it. A relative `MEMORY_FILE_PATH` resolves against that same directory, so it has the same problem.

- When the memory file it resolves is inside a `node_modules` directory, the server prints a warning on stderr at startup naming the file; most clients show a server's stderr in its log. Move the file to the new path when you set the variable, or the server starts on an empty graph.
- The directory must already exist: the server creates the memory file, not the directories above it.
- The default stays where it is so that existing graphs keep loading. The [Docker](#docker) setup above keeps it in a named volume mounted over `/app/dist`, so the graph there survives restarts and draws no warning.

Saves are atomic. Every write tool writes the whole graph to a temporary file in the same directory and renames it over the memory file, so a server stopped or killed mid-save leaves the previous graph intact rather than a half-written file. The file's permission bits are kept across the rename. Writes from several processes are serialized by a lock, described next.

#### Sharing one memory file between clients

Each MCP client starts its own server process, so two clients using the same `MEMORY_FILE_PATH` (or both using the default) are two processes writing one file. Every write tool takes an exclusive lock file, `<memory file>.lock`, next to the memory file while it reads, changes and saves the graph, so writes from different processes take turns and none is lost. The lock file exists only while a write is in progress, so the directory holding the memory file must be writable (it already must be, for the atomic save).

- A lock left behind by a server that crashed mid-write is removed automatically: at once if its process is known to have exited on the same machine, otherwise once it has gone 30 seconds without being refreshed (a server holding the lock refreshes it every 15 seconds while it works). Only one waiting server breaks a stale lock at a time, guarded by a momentary `<memory file>.lock.break` file.
- A write that cannot get the lock within 60 seconds fails with a tool error rather than overwriting the file.
- The lock relies on exclusive file creation, which local filesystems provide; a network filesystem that does not honour it cannot be shared safely this way.

# VS Code Installation Instructions

For quick installation, use one of the one-click installation buttons below:

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-NPM-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=memory&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40modelcontextprotocol%2Fserver-memory%22%5D%7D) [![Install with NPX in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-NPM-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=memory&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40modelcontextprotocol%2Fserver-memory%22%5D%7D&quality=insiders)

[![Install with Docker in VS Code](https://img.shields.io/badge/VS_Code-Docker-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=memory&config=%7B%22command%22%3A%22docker%22%2C%22args%22%3A%5B%22run%22%2C%22-i%22%2C%22-v%22%2C%22claude-memory%3A%2Fapp%2Fdist%22%2C%22--rm%22%2C%22mcp%2Fmemory%22%5D%7D) [![Install with Docker in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Docker-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=memory&config=%7B%22command%22%3A%22docker%22%2C%22args%22%3A%5B%22run%22%2C%22-i%22%2C%22-v%22%2C%22claude-memory%3A%2Fapp%2Fdist%22%2C%22--rm%22%2C%22mcp%2Fmemory%22%5D%7D&quality=insiders)

For manual installation, you can configure the MCP server using one of these methods:

**Method 1: User Configuration (Recommended)**
Add the configuration to your user-level MCP configuration file. Open the Command Palette (`Ctrl + Shift + P`) and run `MCP: Open User Configuration`. This will open your user `mcp.json` file where you can add the server configuration.

**Method 2: Workspace Configuration**
Alternatively, you can add the configuration to a file called `.vscode/mcp.json` in your workspace. This will allow you to share the configuration with others.

> For more details about MCP configuration in VS Code, see the [official VS Code MCP documentation](https://code.visualstudio.com/docs/copilot/customization/mcp-servers).

#### NPX

```json
{
  "servers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@analyticsrequired/memory-mcp"]
    }
  }
}
```

On Windows, use:

```json
{
  "servers": {
    "memory": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@analyticsrequired/memory-mcp"]
    }
  }
}
```

#### Docker

```json
{
  "servers": {
    "memory": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "-v",
        "claude-memory:/app/dist",
        "--rm",
        "mcp/memory"
      ]
    }
  }
}
```

### System Prompt

The prompt for utilizing memory depends on the use case. Changing the prompt will help the model determine the frequency and types of memories created. If you use [namespaces](#namespaces), tell the model which one to work in (for example "use the namespace `project-x` for every memory tool call"), since every call has to name one and the model cannot guess which. Ask it to run `list_namespaces` first and to `create_namespace` only when the one you want is missing.

Here is an example prompt for chat personalization. You could use this prompt in the "Custom Instructions" field of a [Claude.ai Project](https://www.anthropic.com/news/projects).

```
Follow these steps for each interaction:

1. User Identification:
   - You should assume that you are interacting with default_user
   - If you have not identified default_user, proactively try to do so.

2. Memory Retrieval:
   - Always begin your chat by saying only "Remembering..." and retrieve all relevant information from your knowledge graph
   - Always refer to your knowledge graph as your "memory"

3. Memory
   - While conversing with the user, be attentive to any new information that falls into these categories:
     a) Basic Identity (age, gender, location, job title, education level, etc.)
     b) Behaviors (interests, habits, etc.)
     c) Preferences (communication style, preferred language, etc.)
     d) Goals (goals, targets, aspirations, etc.)
     e) Relationships (personal and professional relationships up to 3 degrees of separation)

4. Memory Update:
   - If any new information was gathered during the interaction, update your memory as follows:
     a) Create entities for recurring organizations, people, and significant events
     b) Connect them to the current entities using relations
     c) Store facts about them as observations
```

## Building

Docker:

```sh
docker build -t mcp/memory .
```

For Awareness: a prior mcp/memory volume contains an index.js file that could be overwritten by the new container. If you are using a docker volume for storage, delete the old docker volume's `index.js` file before starting the new container.

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.
