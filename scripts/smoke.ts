import { randomUUID } from "node:crypto";
import { strict as assert } from "node:assert";
import { query, closeDatabase, customerId } from "../src/mastra/support/db";
import { quoteRefund } from "../src/mastra/support/service";
import { supportSession } from "../src/mastra/support/session";
import { neo4jMemory } from "../src/mastra/support/memory";
const base = process.env.SUPPORT_TEST_URL || "http://localhost:4111";
const id = "smoke-" + randomUUID(),
  cookie = randomUUID(),
  threadId = `support-${customerId}-${cookie}`;
async function post(
  path: string,
  body: unknown,
  session = cookie,
  origin = base,
) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `haven_session=${session}`,
      origin,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}
try {
  assert.equal((await fetch(base + "/support")).status, 200);
  await query(
    `MATCH (c:Customer {namespace:$ns,id:$customerId}),(p:Policy {namespace:$ns,id:'P3'}) CREATE (o:Order {namespace:$ns,id:$id,status:'delivered',amountCents:123400,refundedCents:0,currency:'INR',unopened:true,deliveredAt:$date,product:'Temporary test item'}) CREATE (c)-[:PLACED]->(o) CREATE (o)-[:COVERED_BY]->(p)`,
    { id, date: new Date().toISOString() },
  );
  await neo4jMemory.saveThread({
    thread: {
      id: threadId,
      resourceId: customerId,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  const offer = (await supportSession.run(threadId, () =>
    quoteRefund(id, "changed_mind"),
  )) as any;
  assert.ok(offer.quoteId);
  assert.equal(
    (await post("/support/refund", { quoteId: offer.quoteId }, randomUUID()))
      .status,
    403,
  );
  assert.equal(
    (
      await post(
        "/support/refund",
        { quoteId: offer.quoteId },
        cookie,
        "https://example.com",
      )
    ).status,
    403,
  );
  const first = await post("/support/refund", { quoteId: offer.quoteId });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.match(first.data.text, /1,234/);
  assert.equal(
    (await post("/support/refund", { quoteId: offer.quoteId })).status,
    200,
  );
  const rows = await query(
    "MATCH (r:Refund {namespace:$ns})-[:REFUND_FOR]->(:Order {namespace:$ns,id:$id}) RETURN count(r) AS count",
    { id },
  );
  assert.equal(rows[0].count, 1);
  const history = await neo4jMemory.listMessages({
    threadId,
    resourceId: customerId,
  });
  assert.ok(history.messages.length >= 2);
  console.log(
    "HTTP smoke passed: customer page, session-bound confirmation, origin rejection, refund submission, retry idempotency, Neo4j confirmation history.",
  );
} finally {
  await query(
    "MATCH (o:Order {namespace:$ns,id:$id}) OPTIONAL MATCH (r:Refund)-[:REFUND_FOR]->(o) OPTIONAL MATCH (q:SupportQuote)-[:FOR_ORDER]->(o) OPTIONAL MATCH (d:Decision)-[:ABOUT]->(o) DETACH DELETE r,q,d,o",
    { id },
  );
  await neo4jMemory.deleteThread({ threadId });
  await closeDatabase();
}
