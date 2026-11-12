import {
  MemoryStorage,
  type StorageListMessagesInput,
  type StorageListThreadsInput,
  type StorageResourceType,
} from "@mastra/core/storage";
import type { StorageThreadType, MastraDBMessage } from "@mastra/core/memory";
import { query } from "./db";

type Entry = { id: string; createdAt?: Date; updatedAt?: Date };
function decode<T>(json: string): T {
  const value = JSON.parse(json);
  for (const key of ["createdAt", "updatedAt"])
    if (value[key]) value[key] = new Date(value[key]);
  return value;
}
// Namespaced records preserve Mastra's complete message format, including tool results.
// Domain facts and decisions are separate connected graph nodes, not summaries of chat.
export class Neo4jMemory extends MemoryStorage {
  readonly supportsPartialThreadUpdate = true;
  private async get<T>(kind: string, id: string): Promise<T | null> {
    const rows = await query(
      "MATCH (n:SupportMemory {namespace:$ns, kind:$kind, id:$id}) RETURN n.json AS json",
      { kind, id },
    );
    return rows[0] ? decode<T>(rows[0].json) : null;
  }
  private async put<T extends Entry>(kind: string, value: T): Promise<T> {
    await query(
      `MERGE (n:SupportMemory {namespace:$ns, kind:$kind, id:$id}) SET n.json=$json,
      n.resourceId=$resourceId, n.threadId=$threadId, n.createdAt=$createdAt`,
      {
        kind,
        id: value.id,
        json: JSON.stringify(value),
        resourceId: (value as any).resourceId ?? value.id,
        threadId: (value as any).threadId ?? null,
        createdAt: value.createdAt?.toISOString() ?? null,
      },
    );
    if (kind === "thread")
      await query(
        `MATCH (n:SupportMemory {namespace:$ns, kind:'thread', id:$id})
      MATCH (c:Customer {namespace:$ns, id:n.resourceId}) MERGE (c)-[:HAS_CONVERSATION]->(n)`,
        { id: value.id },
      );
    if (kind === "message")
      await query(
        `MATCH (n:SupportMemory {namespace:$ns, kind:'message', id:$id})
      MATCH (t:SupportMemory {namespace:$ns, kind:'thread', id:n.threadId}) MERGE (t)-[:HAS_MESSAGE]->(n)`,
        { id: value.id },
      );
    return value;
  }
  async init() {
    await query(
      "CREATE CONSTRAINT support_memory_key IF NOT EXISTS FOR (n:SupportMemory) REQUIRE (n.namespace,n.kind,n.id) IS UNIQUE",
    );
  }
  async dangerouslyClearAll() {
    await query("MATCH (n:SupportMemory {namespace:$ns}) DETACH DELETE n");
  }
  async getThreadById({
    threadId,
    resourceId,
  }: {
    threadId: string;
    resourceId?: string;
  }) {
    const thread = await this.get<StorageThreadType>("thread", threadId);
    return thread && (!resourceId || thread.resourceId === resourceId)
      ? thread
      : null;
  }
  async saveThread({ thread }: { thread: StorageThreadType }) {
    const existing = await this.getThreadById({ threadId: thread.id });
    if (existing && existing.resourceId !== thread.resourceId)
      throw new Error("Conversation ownership mismatch");
    return this.put("thread", thread);
  }
  async updateThread({
    id,
    title,
    metadata,
  }: {
    id: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }) {
    const thread = await this.getThreadById({ threadId: id });
    if (!thread) throw new Error("Conversation not found");
    return this.put("thread", {
      ...thread,
      ...(title !== undefined ? { title } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      updatedAt: new Date(),
    });
  }
  async deleteThread({ threadId }: { threadId: string }) {
    await query(
      "MATCH (n:SupportMemory {namespace:$ns}) WHERE (n.kind='thread' AND n.id=$threadId) OR (n.kind='message' AND n.threadId=$threadId) DETACH DELETE n",
      { threadId },
    );
  }
  private async all<T>(kind: string): Promise<T[]> {
    return (
      await query(
        "MATCH (n:SupportMemory {namespace:$ns,kind:$kind}) RETURN n.json AS json",
        { kind },
      )
    ).map((r) => decode<T>(r.json));
  }
  async listThreads(args: StorageListThreadsInput) {
    const threads = (await this.all<StorageThreadType>("thread")).filter(
      (t) =>
        (!args.filter?.resourceId || t.resourceId === args.filter.resourceId) &&
        Object.entries(args.filter?.metadata ?? {}).every(
          ([k, v]) => t.metadata?.[k] === v,
        ),
    );
    const field = args.orderBy?.field ?? "createdAt";
    const sign = args.orderBy?.direction === "ASC" ? 1 : -1;
    threads.sort((a, b) => sign * (a[field].getTime() - b[field].getTime()));
    return {
      ...page(threads, args, 100),
      threads: page(threads, args, 100).items,
    };
  }
  async listMessages(args: StorageListMessagesInput) {
    if (args.include?.length)
      throw new Error("Message-neighbor retrieval is not enabled");
    const ids = Array.isArray(args.threadId) ? args.threadId : [args.threadId];
    const range = args.filter?.dateRange;
    const messages = (await this.all<MastraDBMessage>("message")).filter(
      (m) =>
        ids.includes(m.threadId!) &&
        (!args.resourceId || m.resourceId === args.resourceId) &&
        (!range?.start ||
          (range.startExclusive
            ? m.createdAt > range.start
            : m.createdAt >= range.start)) &&
        (!range?.end ||
          (range.endExclusive
            ? m.createdAt < range.end
            : m.createdAt <= range.end)) &&
        Object.entries(args.filter?.metadata ?? {}).every(
          ([k, v]) => (m.content as any).metadata?.[k] === v,
        ),
    );
    const sign = args.orderBy?.direction === "DESC" ? -1 : 1;
    messages.sort(
      (a, b) =>
        sign *
        (a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id)),
    );
    const result = page(messages, args, 40);
    return { ...result, messages: result.items };
  }
  async listMessagesById({ messageIds }: { messageIds: string[] }) {
    const messages = await Promise.all(
      messageIds.map((id) => this.get<MastraDBMessage>("message", id)),
    );
    return { messages: messages.filter((m): m is MastraDBMessage => !!m) };
  }
  async saveMessages({ messages }: { messages: MastraDBMessage[] }) {
    for (const m of messages) await this.put("message", m);
    return { messages };
  }
  async updateMessages({
    messages,
  }: Parameters<MemoryStorage["updateMessages"]>[0]) {
    const result: MastraDBMessage[] = [];
    for (const patch of messages) {
      const old = await this.get<MastraDBMessage>("message", patch.id);
      if (old)
        result.push(
          await this.put("message", {
            ...old,
            ...patch,
            content: { ...old.content, ...patch.content },
          } as MastraDBMessage),
        );
    }
    return result;
  }
  async deleteMessages(messageIds: string[]) {
    await query(
      "MATCH (n:SupportMemory {namespace:$ns,kind:'message'}) WHERE n.id IN $messageIds DETACH DELETE n",
      { messageIds },
    );
  }
  async getResourceById({ resourceId }: { resourceId: string }) {
    return this.get<StorageResourceType>("resource", resourceId);
  }
  async saveResource({ resource }: { resource: StorageResourceType }) {
    return this.put("resource", resource);
  }
  async updateResource({
    resourceId,
    ...patch
  }: {
    resourceId: string;
    workingMemory?: string;
    metadata?: Record<string, unknown>;
  }) {
    const old = await this.getResourceById({ resourceId });
    return this.put("resource", {
      ...old,
      ...patch,
      id: resourceId,
      createdAt: old?.createdAt ?? new Date(),
      updatedAt: new Date(),
    });
  }
}
function page<T>(
  items: T[],
  args: { page?: number; perPage?: number | false },
  fallback: number,
) {
  const page = args.page ?? 0,
    perPage = args.perPage ?? fallback;
  const start = perPage === false ? 0 : page * perPage;
  return {
    items: perPage === false ? items : items.slice(start, start + perPage),
    total: items.length,
    page,
    perPage,
    hasMore: perPage !== false && start + perPage < items.length,
  };
}
export const neo4jMemory = new Neo4jMemory();
