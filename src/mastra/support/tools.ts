import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { customerContext, quoteRefund, arrangePickup } from "./service";
export const orderContext = createTool({
  id: "order-context",
  description:
    "Read the signed-in customer’s orders, current tracking, policy, existing cases, verified evidence, earlier approvals and refunds. Always read before answering order questions.",
  inputSchema: z.object({ orderId: z.string().optional() }),
  execute: async ({ orderId }) => customerContext(orderId),
});
export const refundOffer = createTool({
  id: "refund-offer",
  description:
    "Check deterministic refund eligibility and prepare a refund offer for customer review. Does not submit a refund. The customer must click the confirmation button in the chat.",
  inputSchema: z.object({
    orderId: z.string(),
    reason: z.enum(["damaged", "changed_mind"]),
  }),
  execute: async ({ orderId, reason }) => quoteRefund(orderId, reason),
});
export const pickupRequest = createTool({
  id: "pickup-request",
  description:
    "Request a demo return pickup for a previously approved replacement, only when the customer explicitly asks to arrange pickup. Does not book a real courier.",
  inputSchema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => arrangePickup(orderId),
});
export const supportTools = { orderContext, refundOffer, pickupRequest };
