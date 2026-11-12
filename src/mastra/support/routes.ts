import { randomUUID } from "node:crypto";
import { registerApiRoute } from "@mastra/core/server";
import { z } from "zod";
import { supportSession } from "./session";
import { supportPage } from "./page";
import { query, customerId } from "./db";
import { neo4jMemory } from "./memory";
import { confirmRefund } from "./service";

// This is a single signed-in demo account, never a customer ID supplied by the browser.
// Use an authenticated identity middleware before exposing this app to real customers.
function session(c: any) {
  const cookie = c.req.header("cookie") ?? "";
  const existing = /(?:^|;\s*)haven_session=([0-9a-f-]{36})(?:;|$)/.exec(
    cookie,
  )?.[1];
  const id = existing ?? randomUUID();
  if (!existing)
    c.header(
      "Set-Cookie",
      `haven_session=${id}; HttpOnly; SameSite=Strict; Path=/support; Max-Age=86400`,
    );
  return `support-${customerId}-${id}`;
}
function sameOrigin(c: any) {
  const origin = c.req.header("origin");
  return !origin || origin === new URL(c.req.url).origin;
}
const active = new Set<string>();
export const supportRoutes = [
  registerApiRoute("/support", {
    method: "GET",
    handler: async (c) => {
      session(c);
      return c.html(supportPage);
    },
  }),
  registerApiRoute("/support/session", {
    method: "POST",
    handler: async (c) => {
      if (!sameOrigin(c))
        return c.json({ message: "Request not allowed." }, 403);
      c.header(
        "Set-Cookie",
        `haven_session=${randomUUID()}; HttpOnly; SameSite=Strict; Path=/support; Max-Age=86400`,
      );
      return c.json({ ok: true });
    },
  }),
  registerApiRoute("/support/chat", {
    method: "POST",
    handler: async (c) => {
      if (!sameOrigin(c))
        return c.json({ message: "Request not allowed." }, 403);
      const parsed = z
        .object({ message: z.string().trim().min(1).max(4000) })
        .safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        return c.json(
          { message: "Please enter a message of up to 4,000 characters." },
          400,
        );
      const threadId = session(c);
      if (active.has(threadId))
        return c.json({ message: "Please wait for the current reply." }, 409);
      active.add(threadId);
      try {
        const result = await supportSession.run(threadId, () =>
          c
            .get("mastra")
            .getAgent("agent")
            .generate(parsed.data.message, {
              memory: { thread: threadId, resource: customerId },
            }),
        );
        // The server binds offers to the conversation when the tool creates them.
        const offers = await query(
          `MATCH (q:SupportQuote {namespace:$ns,customerId:$customerId,threadId:$threadId}) WHERE q.expiresAt>$now AND NOT EXISTS { MATCH (:Refund {namespace:$ns,id:q.id}) }
        RETURN q.id AS id,q.amountCents AS amountCents ORDER BY q.expiresAt DESC LIMIT 1`,
          { now: new Date().toISOString(), threadId },
        );
        return c.json({ text: result.text, offer: offers[0] ?? null });
      } catch (error) {
        console.error("Customer support request failed", error);
        return c.json(
          {
            message:
              "We couldn’t check that just now. Please try again in a moment.",
          },
          503,
        );
      } finally {
        active.delete(threadId);
      }
    },
  }),
  registerApiRoute("/support/refund", {
    method: "POST",
    handler: async (c) => {
      if (!sameOrigin(c))
        return c.json({ message: "Request not allowed." }, 403);
      const parsed = z
        .object({ quoteId: z.string().uuid() })
        .safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        return c.json({ message: "Please request a new refund offer." }, 400);
      const threadId = session(c);
      try {
        const offers = await query(
          "MATCH (q:SupportQuote {namespace:$ns,id:$id,customerId:$customerId,threadId:$threadId}) RETURN q.id AS id",
          { id: parsed.data.quoteId, threadId },
        );
        if (!offers.length)
          return c.json(
            {
              message:
                "Please confirm the offer in the conversation where it was created.",
            },
            403,
          );
        const result = await confirmRefund(parsed.data.quoteId);
        if ("error" in result) return c.json({ message: result.error }, 409);
        const amount = new Intl.NumberFormat("en-IN", {
          style: "currency",
          currency: "INR",
        }).format(result.refund.amountCents / 100);
        const text = `Your demo refund request for ${amount} ${result.alreadySubmitted ? "was already recorded" : "has been recorded"}. Reference: ${result.refund.id}. The refund would go to your original payment method in 5–7 business days. No real payment has been made in this demo.`;
        const now = new Date();
        await neo4jMemory.saveMessages({
          messages: [
            {
              id: randomUUID(),
              role: "user",
              threadId,
              resourceId: customerId,
              createdAt: now,
              content: {
                format: 2,
                parts: [{ type: "text", text: "I confirm the refund offer." }],
              },
            },
            {
              id: randomUUID(),
              role: "assistant",
              threadId,
              resourceId: customerId,
              createdAt: new Date(now.getTime() + 1),
              content: { format: 2, parts: [{ type: "text", text }] },
            },
          ],
        });
        return c.json({ text });
      } catch (error) {
        console.error("Refund request failed", error);
        return c.json(
          {
            message:
              "We couldn’t submit that just now. Please try again; duplicate requests are protected.",
          },
          503,
        );
      }
    },
  }),
];
