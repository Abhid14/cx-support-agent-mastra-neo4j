import { query, closeDatabase, namespace } from "../src/mastra/support/db";

const ago = (days: number) =>
  new Date(Date.now() - days * 86400000).toISOString();
try {
  for (const label of [
    "Customer",
    "Order",
    "Case",
    "Evidence",
    "Decision",
    "Policy",
    "Refund",
    "SupportEvent",
    "SupportQuote",
  ]) {
    await query(
      `CREATE CONSTRAINT support_${label.toLowerCase()}_key IF NOT EXISTS FOR (n:${label}) REQUIRE (n.namespace,n.id) IS UNIQUE`,
    );
  }
  const customers = [
    {
      id: "asha",
      name: "Asha Sharma",
      email: "asha@example.com",
      preference: "Short updates; do not request evidence already supplied.",
    },
    {
      id: "ravi",
      name: "Ravi Rao",
      email: "ravi@example.com",
      preference: "Email updates.",
    },
  ];
  for (const customer of customers)
    await query(
      "MERGE (c:Customer {namespace:$ns,id:$customer.id}) ON CREATE SET c += $customer",
      { customer },
    );
  await query(
    `MERGE (p:Policy {namespace:$ns,id:'P3'}) SET p.name='Damaged or unwanted items',p.version='2026-11',p.windowDays=30,p.requiresEvidence=true,p.refundDays='5–7 business days',p.text='Delivered orders within 30 days qualify. Damage requires verified evidence or a prior approval. Change-of-mind returns require an unopened item. Refunds go to the original payment method; original delivery fees are excluded.'`,
  );
  const orders = [
    {
      id: "42",
      owner: "asha",
      product: "Aurora Wireless Headphones",
      amountCents: 799900,
      status: "delivered",
      deliveredAt: ago(10),
      unopened: false,
      tracking: "Delivered to reception",
      currency: "INR",
    },
    {
      id: "43",
      owner: "asha",
      product: "BrewMate Coffee Grinder",
      amountCents: 349900,
      status: "in_transit",
      deliveredAt: "",
      unopened: false,
      tracking: "Delayed at Bengaluru hub; expected in 2 business days",
      currency: "INR",
    },
    {
      id: "44",
      owner: "asha",
      product: "TrailPack Daypack",
      amountCents: 249900,
      status: "delivered",
      deliveredAt: ago(5),
      unopened: true,
      tracking: "Delivered",
      currency: "INR",
    },
    {
      id: "45",
      owner: "asha",
      product: "DeskGlow Lamp",
      amountCents: 189900,
      status: "delivered",
      deliveredAt: ago(48),
      unopened: true,
      tracking: "Delivered",
      currency: "INR",
    },
    {
      id: "46",
      owner: "asha",
      product: "Hydra Steel Bottle",
      amountCents: 99900,
      status: "refunded",
      deliveredAt: ago(15),
      unopened: false,
      tracking: "Return collected",
      currency: "INR",
    },
    {
      id: "99",
      owner: "ravi",
      product: "Studio Monitor",
      amountCents: 2299900,
      status: "delivered",
      deliveredAt: ago(3),
      unopened: true,
      tracking: "Delivered",
      currency: "INR",
    },
  ];
  for (const order of orders)
    await query(
      `MATCH (c:Customer {namespace:$ns,id:$order.owner}) MATCH (p:Policy {namespace:$ns,id:'P3'})
    MERGE (o:Order {namespace:$ns,id:$order.id}) ON CREATE SET o += $order,o.refundedCents=0,o.createdAt=$createdAt
    MERGE (c)-[:PLACED]->(o) MERGE (o)-[:COVERED_BY]->(p)`,
      { order, createdAt: ago(20) },
    );
  await query(
    `MATCH (o:Order {namespace:$ns,id:'42'}),(p:Policy {namespace:$ns,id:'P3'}),(c:Customer {namespace:$ns,id:'asha'})
    MERGE (k:Case {namespace:$ns,id:'17'}) ON CREATE SET k.status='replacement_approved',k.summary='Left earcup does not work; box crushed. Photo verified. Replacement approved; return pickup pending.',k.createdAt=$yesterday
    MERGE (k)-[:ABOUT]->(o) MERGE (c)-[:HAS_CASE]->(k)
    MERGE (e:Evidence {namespace:$ns,id:'photo-8'}) ON CREATE SET e.name='damaged-headphones.jpg',e.verified=true,e.receivedAt=$yesterday,e.source='Customer upload reviewed by Meera'
    MERGE (k)-[:HAS_EVIDENCE]->(e) MERGE (e)-[:EVIDENCE_FOR]->(o)
    MERGE (d:Decision {namespace:$ns,id:'approval-9'}) ON CREATE SET d.action='replacement',d.status='approved',d.actor='Meera',d.reason='Verified damage within 30-day policy',d.createdAt=$yesterday
    MERGE (d)-[:FOR_CASE]->(k) MERGE (d)-[:SUPPORTED_BY]->(e) MERGE (d)-[:APPLIED]->(p)`,
    { yesterday: ago(1) },
  );
  await query(
    `MATCH (o:Order {namespace:$ns,id:'46'})
    MERGE (r:Refund {namespace:$ns,id:'seed-refund-46'}) ON CREATE SET r.amountCents=99900,r.status='completed',r.createdAt=$date,r.reason='Damaged seal',r.demo=true
    MERGE (r)-[:REFUND_FOR]->(o) SET o.refundedCents=99900`,
    { date: ago(7) },
  );
  await query(
    `MATCH (c:Customer {namespace:$ns,id:'asha'}),(o:Order {namespace:$ns,id:'42'})
    MERGE (e:SupportEvent {namespace:$ns,id:'yesterday-contact'}) ON CREATE SET e.type='customer_contact',e.summary='Asha supplied damage photo and requested replacement. Meera approved. Pickup remains pending.',e.createdAt=$date
    MERGE (c)-[:HAS_EVENT]->(e) MERGE (e)-[:ABOUT]->(o)`,
    { date: ago(1) },
  );
  console.log(
    `Demo seeded without deleting existing data (${namespace}): 2 customers, 6 orders, evidence, policy, approval, completed refund.`,
  );
} finally {
  await closeDatabase();
}
