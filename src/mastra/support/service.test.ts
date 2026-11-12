import { test, expect, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  eligibility,
  customerContext,
  quoteRefund,
  confirmRefund,
} from "./service";
import { query, closeDatabase } from "./db";
import { neo4jMemory } from "./memory";
const prefix = "test-" + randomUUID();
const order = {
  status: "delivered",
  deliveredAt: new Date(Date.now() - 5 * 86400000).toISOString(),
  amountCents: 10000,
  refundedCents: 0,
  currency: "INR",
  unopened: true,
};
test("policy enforces delivery, time window, damage evidence, unopened returns and remaining balance", () => {
  const p = { windowDays: 30 };
  expect(eligibility(order, p, "damaged", []).eligible).toBe(false);
  expect(eligibility(order, p, "damaged", [{ verified: true }]).eligible).toBe(
    true,
  );
  expect(
    eligibility({ ...order, status: "in_transit" }, p, "changed_mind", [])
      .eligible,
  ).toBe(false);
  expect(
    eligibility({ ...order, deliveredAt: "2020-01-01" }, p, "changed_mind", [])
      .eligible,
  ).toBe(false);
  expect(
    eligibility({ ...order, unopened: false }, p, "changed_mind", []).eligible,
  ).toBe(false);
  expect(
    eligibility({ ...order, refundedCents: 10000 }, p, "changed_mind", [])
      .eligible,
  ).toBe(false);
});
test("Aura context preserves photo and specialist approval; foreign customer is inaccessible", async () => {
  const context = await customerContext("42");
  expect(
    context.orders?.[0].evidence.some((e: any) => e.id === "photo-8"),
  ).toBe(true);
  expect(
    context.orders?.[0].decisions.some((d: any) => d.actor === "Meera"),
  ).toBe(true);
  expect((await customerContext("99")).orders).toBeUndefined();
});
test("refund confirmation is transactional and idempotent under concurrent submissions", async () => {
  await query(
    `MATCH (c:Customer {namespace:$ns,id:$customerId}),(p:Policy {namespace:$ns,id:'P3'}) CREATE (o:Order {namespace:$ns,id:$id}) SET o += $order CREATE (c)-[:PLACED]->(o) CREATE (o)-[:COVERED_BY]->(p)`,
    { id: prefix, order },
  );
  const offer = await quoteRefund(prefix, "changed_mind");
  expect("quoteId" in offer).toBe(true);
  const id = (offer as any).quoteId;
  const results = await Promise.all([confirmRefund(id), confirmRefund(id)]);
  expect(results.every((r) => "refund" in r)).toBe(true);
  const rows = await query(
    "MATCH (r:Refund {namespace:$ns})-[:REFUND_FOR]->(o:Order {namespace:$ns,id:$id}) RETURN count(r) AS count,o.refundedCents AS total",
    { id: prefix },
  );
  expect(rows[0].count).toBe(1);
  expect(rows[0].total).toBe(10000);
  expect("quoteId" in (await quoteRefund(prefix, "changed_mind"))).toBe(false);
});
test("Neo4j chat history roundtrips across adapter instances and enforces resource filtering", async () => {
  const now = new Date();
  await neo4jMemory.saveThread({
    thread: { id: prefix, resourceId: "asha", createdAt: now, updatedAt: now },
  });
  await neo4jMemory.saveMessages({
    messages: [
      {
        id: prefix,
        threadId: prefix,
        resourceId: "asha",
        createdAt: now,
        role: "user",
        content: {
          format: 2,
          parts: [{ type: "text", text: "Remember my headphones." }],
        },
      },
    ],
  });
  const { Neo4jMemory } = await import("./memory");
  const other = new Neo4jMemory();
  expect(
    (await other.listMessages({ threadId: prefix, resourceId: "asha" }))
      .messages.length,
  ).toBe(1);
  expect(
    (await other.listMessages({ threadId: prefix, resourceId: "ravi" }))
      .messages.length,
  ).toBe(0);
  expect(
    await other.getThreadById({ threadId: prefix, resourceId: "ravi" }),
  ).toBeNull();
});
afterAll(async () => {
  await query(
    `MATCH (o:Order {namespace:$ns,id:$id}) OPTIONAL MATCH (r:Refund)-[:REFUND_FOR]->(o) OPTIONAL MATCH (q:SupportQuote)-[:FOR_ORDER]->(o) OPTIONAL MATCH (d:Decision)-[:ABOUT]->(o) DETACH DELETE r,q,d,o`,
    { id: prefix },
  );
  await neo4jMemory.deleteThread({ threadId: prefix });
  await closeDatabase();
});
