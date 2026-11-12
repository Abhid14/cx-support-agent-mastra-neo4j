import { supportSession } from "./session";
import { randomUUID } from "node:crypto";
import { query, transaction, namespace, customerId } from "./db";

export async function customerContext(orderId?: string) {
  const rows = await query(
    `MATCH (c:Customer {namespace:$ns,id:$customerId})-[:PLACED]->(o:Order)
    WHERE $orderId IS NULL OR o.id=$orderId
    MATCH (o)-[:COVERED_BY]->(p:Policy)
    OPTIONAL MATCH (k:Case)-[:ABOUT]->(o)
    OPTIONAL MATCH (k)-[:HAS_EVIDENCE]->(e:Evidence)
    OPTIONAL MATCH (d:Decision)-[:FOR_CASE]->(k)
    OPTIONAL MATCH (r:Refund)-[:REFUND_FOR]->(o)
    RETURN c{.name,.preference} AS customer, properties(o) AS order,properties(p) AS policy,
      collect(DISTINCT properties(k)) AS cases,collect(DISTINCT properties(e)) AS evidence,
      collect(DISTINCT properties(d)) AS decisions,collect(DISTINCT properties(r)) AS refunds ORDER BY order.id`,
    { orderId: orderId ?? null },
  );
  return rows.length
    ? { orders: rows }
    : { message: "No matching order found for your account." };
}
export function eligibility(
  order: any,
  policy: any,
  reason: string,
  evidence: any[],
) {
  if (order.status !== "delivered")
    return {
      eligible: false,
      reason:
        "Only delivered orders can be returned. This order may be in transit or already refunded.",
    };
  const age = (Date.now() - Date.parse(order.deliveredAt)) / 86400000;
  if (!Number.isFinite(age) || age < 0 || age > policy.windowDays)
    return {
      eligible: false,
      reason: `This order is outside the ${policy.windowDays}-day return window.`,
    };
  if (reason === "damaged" && !evidence.some((e) => e.verified))
    return {
      eligible: false,
      reason:
        "A verified damage photo or a specialist review is needed before this refund can proceed.",
    };
  if (reason === "changed_mind" && !order.unopened)
    return {
      eligible: false,
      reason: "Change-of-mind returns must be unopened.",
    };
  const amountCents = order.amountCents - (order.refundedCents ?? 0);
  return amountCents > 0
    ? { eligible: true, amountCents, currency: order.currency }
    : {
        eligible: false,
        reason: "This order has already been fully refunded.",
      };
}
export async function quoteRefund(
  orderId: string,
  reason: "damaged" | "changed_mind",
) {
  const context = await customerContext(orderId);
  if (!context.orders?.length) return context;
  const row = context.orders[0];
  const result = eligibility(row.order, row.policy, reason, row.evidence);
  await query(
    `MATCH (c:Customer {namespace:$ns,id:$customerId})-[:PLACED]->(o:Order {id:$orderId})
    CREATE (d:Decision {namespace:$ns,id:$id,action:'refund_eligibility',status:$status,reason:$explanation,createdAt:$now,actor:'policy-engine'})
    CREATE (d)-[:ABOUT]->(o) WITH d,o MATCH (o)-[:COVERED_BY]->(p) CREATE (d)-[:APPLIED]->(p)
    WITH d,o OPTIONAL MATCH (k:Case)-[:ABOUT]->(o) OPTIONAL MATCH (k)-[:HAS_EVIDENCE]->(e:Evidence)
    FOREACH (ev IN CASE WHEN e IS NULL THEN [] ELSE [e] END | MERGE (d)-[:SUPPORTED_BY]->(ev))`,
    {
      orderId,
      id: randomUUID(),
      status: result.eligible ? "eligible" : "ineligible",
      explanation: result.eligible
        ? "Within policy; evidence and remaining amount validated"
        : result.reason,
      now: new Date().toISOString(),
    },
  );
  if (!result.eligible) return result;
  const quoteId = randomUUID();
  await query(
    `MATCH (c:Customer {namespace:$ns,id:$customerId})-[:PLACED]->(o:Order {id:$orderId})
    CREATE (q:SupportQuote {namespace:$ns,id:$quoteId,reason:$reason,amountCents:$amountCents,customerId:$customerId,threadId:$threadId,expiresAt:$expiresAt}) CREATE (q)-[:FOR_ORDER]->(o)`,
    {
      orderId,
      reason,
      quoteId,
      threadId: supportSession.getStore() ?? null,
      amountCents: result.amountCents,
      expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
    },
  );
  return {
    ...result,
    quoteId,
    orderId,
    product: row.order.product,
    timing: row.policy.refundDays,
    method: "original payment method",
    requiresConfirmation: true,
    notice: "Demo refund request; no payment transfer is made.",
  };
}
export async function confirmRefund(quoteId: string) {
  return transaction(async (tx) => {
    const params = { ns: namespace, customerId, quoteId };
    const res = await tx.run(
      `MATCH (c:Customer {namespace:$ns,id:$customerId})-[:PLACED]->(o:Order)<-[:FOR_ORDER]-(q:SupportQuote {namespace:$ns,id:$quoteId,customerId:$customerId})
      SET o.lockVersion=coalesce(o.lockVersion,0)+1
      WITH o,q MATCH (o)-[:COVERED_BY]->(p:Policy)
      OPTIONAL MATCH (k:Case)-[:ABOUT]->(o) OPTIONAL MATCH (k)-[:HAS_EVIDENCE]->(e:Evidence)
      OPTIONAL MATCH (r:Refund {namespace:$ns,id:$quoteId})-[:REFUND_FOR]->(o)
      RETURN properties(o) AS o,properties(q) AS q,properties(p) AS p,collect(DISTINCT properties(e)) AS evidence,properties(r) AS refund`,
      params,
    );
    if (!res.records.length)
      return { error: "Refund request not found for your account." };
    const row = res.records[0].toObject();
    if (row.refund) return { refund: row.refund, alreadySubmitted: true };
    if (Date.parse(row.q.expiresAt) < Date.now())
      return {
        error: "This refund offer has expired. Please request a fresh offer.",
      };
    const valid = eligibility(row.o, row.p, row.q.reason, row.evidence);
    if (!valid.eligible || valid.amountCents !== row.q.amountCents)
      return {
        error:
          valid.reason ?? "The order changed. Please request a fresh offer.",
      };
    const now = new Date().toISOString();
    const write = await tx.run(
      `MATCH (o:Order {namespace:$ns,id:$orderId}),(q:SupportQuote {namespace:$ns,id:$quoteId}),(p:Policy {namespace:$ns,id:'P3'})
      CREATE (r:Refund {namespace:$ns,id:$quoteId,status:'requested',amountCents:$amountCents,currency:$currency,reason:$reason,createdAt:$now,demo:true})
      CREATE (r)-[:REFUND_FOR]->(o) CREATE (r)-[:CONFIRMED_FROM]->(q)
      SET o.refundedCents=coalesce(o.refundedCents,0)+$amountCents,o.status='refund_requested'
      CREATE (d:Decision {namespace:$ns,id:$decisionId,action:'refund_request',status:'submitted',actor:'customer-confirmed',createdAt:$now,reason:'Customer confirmed quoted refund; policy revalidated under order lock'})
      CREATE (d)-[:RESULTED_IN]->(r) CREATE (d)-[:APPLIED]->(p) CREATE (d)-[:ABOUT]->(o)
      WITH r,o,d OPTIONAL MATCH (k:Case)-[:ABOUT]->(o) OPTIONAL MATCH (k)-[:HAS_EVIDENCE]->(e:Evidence)
      FOREACH (ev IN CASE WHEN e IS NULL THEN [] ELSE [e] END | MERGE (d)-[:SUPPORTED_BY]->(ev))
      FOREACH (cs IN CASE WHEN k IS NULL THEN [] ELSE [k] END | SET cs.status='refund_requested' MERGE (d)-[:FOR_CASE]->(cs))
      RETURN DISTINCT properties(r) AS refund`,
      {
        ...params,
        orderId: row.o.id,
        amountCents: valid.amountCents,
        currency: row.o.currency,
        reason: row.q.reason,
        now,
        decisionId: randomUUID(),
      },
    );
    return {
      refund: write.records[0].get("refund"),
      notice: "Demo request recorded. No payment transfer has been made.",
    };
  });
}
export async function arrangePickup(orderId: string) {
  const rows = await query(
    `MATCH (:Customer {namespace:$ns,id:$customerId})-[:PLACED]->(o:Order {id:$orderId})<-[:ABOUT]-(k:Case {status:'replacement_approved'})
    MATCH (d:Decision {status:'approved',action:'replacement'})-[:FOR_CASE]->(k)
    MERGE (e:SupportEvent {namespace:$ns,id:'pickup-'+$orderId}) ON CREATE SET e.type='pickup_requested',e.createdAt=$now,e.summary='Customer requested pickup; scheduling team will confirm a slot',e.demo=true
    MERGE (e)-[:ABOUT]->(o) MERGE (k)-[:HAS_EVENT]->(e) RETURN e.summary AS status`,
    { orderId, now: new Date().toISOString() },
  );
  return (
    rows[0] ?? { message: "No approved replacement awaiting pickup was found." }
  );
}
