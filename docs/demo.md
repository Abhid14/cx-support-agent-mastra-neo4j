# Context graph demo guide

Use `/support` for the customer-facing demo. Keep Neo4j Browser in a separate presenter-only tab. All nodes created here use `namespace = 'sxp-support-demo-v1'`; the seed never wipes the database.

## Three-minute walkthrough

1. Ask: “Any update on my headphones replacement?” The agent resumes Order 42 / Case 17 with Meera’s prior approval and the verified photo.
2. Ask: “Do you need the photo again?” It should acknowledge the evidence already received.
3. Start a new conversation and ask the replacement question again. The case survives the new session.
4. Ask: “Actually, I’d prefer a refund for the damaged headphones.” The policy engine checks the evidence and prepares ₹7,999 for review.
5. Click the confirmation button. This records a demo refund request, an auditable decision, policy links, and evidence links. No money moves.
6. Ask again about the refund; it should recognize the request. Use Order 44 for a second eligible return, 45 for an expired return, and 46 for duplicate prevention.

For repeated sessions, the seed intentionally preserves submitted refunds. Do not reset customer activity by wiping Aura. Use a fresh explicitly prepared demo order or a new namespace if you need repeatable writable scenarios.

## Inspect the connected case

```cypher
MATCH (customer:Customer {namespace:'sxp-support-demo-v1',id:'asha'})-[:PLACED]->(o:Order {id:'42'})
MATCH (o)-[:COVERED_BY]->(p:Policy)
OPTIONAL MATCH (c:Case)-[:ABOUT]->(o)
OPTIONAL MATCH (c)-[:HAS_EVIDENCE]->(e:Evidence)
OPTIONAL MATCH (d:Decision)-[:FOR_CASE]->(c)
RETURN customer,o,p,c,e,d;
```

## Explain a refund decision

```cypher
MATCH (d:Decision {namespace:'sxp-support-demo-v1',action:'refund_request'})-[:RESULTED_IN]->(r:Refund)-[:REFUND_FOR]->(o:Order)
MATCH (d)-[:APPLIED]->(p:Policy)
OPTIONAL MATCH (d)-[:SUPPORTED_BY]->(e:Evidence)
RETURN o,d,r,p,e;
```

## Compare completed and pending work

```cypher
MATCH (c:Customer {namespace:'sxp-support-demo-v1',id:'asha'})-[:PLACED]->(o:Order)
OPTIONAL MATCH (r:Refund)-[:REFUND_FOR]->(o)
RETURN o.id AS orderNumber,o.product AS product,o.status AS orderStatus,
       r.status AS refundStatus,r.amountCents/100.0 AS refundINR
ORDER BY orderNumber;
```

## See conversation memory connected to the customer

```cypher
MATCH (c:Customer {namespace:'sxp-support-demo-v1',id:'asha'})-[:HAS_CONVERSATION]->(t:SupportMemory)
OPTIONAL MATCH (t)-[:HAS_MESSAGE]->(m:SupportMemory)
RETURN c,t,m LIMIT 100;
```

`SupportMemory.json` holds the complete Mastra thread or message payload. Business facts and actions are separate graph records, so the case can be retrieved without replaying old chat or trusting a model-written summary.
