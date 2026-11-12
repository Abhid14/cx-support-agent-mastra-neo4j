# Haven customer support · Mastra + Neo4j

A working order-support demo using Azure GPT-6 Luna and Neo4j Aura. The customer chat shows customer conversations and an explicit refund confirmation button. It never renders tool calls, Cypher, traces, or retrieved records.

## Run

Keep your existing Azure and Neo4j credentials in `.env`; `.env.example` lists the required names with blank values.

```sh
bun install
bun run seed
bun run dev
```

Open **[Customer chat](http://localhost:4111/support)**. The demo is signed in as **Asha Sharma**. [Mastra Studio](http://localhost:4111) is for developers; it deliberately exposes tools and diagnostics, so use `/support` for customer demos.

The Azure deployment defaults to `gpt-6-luna`. `AZURE_RESOURCE_NAME` is the name before `.openai.azure.com`, not a project endpoint.

## Demo stories

| Prompt                                                    | Expected behavior                                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| “Any update on my headphones replacement?”                | Order 42: reuse Meera’s approval and the verified photo; pickup is pending. No repeated evidence request. |
| “I sent the photo yesterday. Do you still need it?”       | Acknowledge that the photo was received and reviewed.                                                     |
| “Please arrange the pickup.”                              | Record a demo pickup request; a slot still needs confirmation.                                            |
| “I’d prefer a refund for the damaged headphones instead.” | Offer ₹7,999 using the existing verified evidence; customer confirms with the button.                     |
| “Where is order 43?”                                      | Explain the Bengaluru-hub delay and the recorded two-business-day estimate.                               |
| “Return my unopened daypack, order 44.”                   | Offer ₹2,499, original payment method, 5–7 business days; require the confirmation button.                |
| “Return my lamp, order 45.”                               | Explain that the 30-day return window has passed.                                                         |
| “Refund order 46 again.”                                  | Recognize the completed ₹999 refund; do not create another.                                               |
| “Show me order 99.”                                       | No matching order in this account; Ravi’s order stays private.                                            |

“New conversation” starts fresh chat history while retaining customer facts, evidence, approvals, and refund state. Refreshing the page resets the visible transcript, but the session’s history is still retrieved from Neo4j on the next turn.

## Memory and context graphs

All application conversation memory is stored in Neo4j: threads, full Mastra messages (including tool results), customer records, orders, policies, evidence, cases, decisions, refund offers, and refund requests. There is no SQLite or DuckDB fallback. Observational memory and vector recall are disabled: continuity comes from structured graph retrieval plus the latest 30 chat messages.

The Neo4j memory domain implements the installed Mastra `MemoryStorage` API. Conversation records use `SupportMemory` nodes with serialized message payloads and relationships to customers and threads; business facts use directly queryable graph nodes. This small demo adapter does not implement observational memory, semantic neighbor retrieval, distributed run fencing, or large-scale server-side pagination.

Three native Mastra skills cover order care, refunds, and customer continuity. The agent has only scoped support tools; no shell, filesystem, web search, or arbitrary Cypher access. The direct driver uses the same Aura credentials as any separately configured Neo4j MCP connection. An MCP server is not required.

## Refund behavior

Eligibility is deterministic and rechecked under an order write lock. Damage refunds need existing verified evidence, and change-of-mind returns need an unopened item. Offers expire after 30 minutes. Only a server-validated, same-session confirmation button can submit a refund. Retries and concurrent confirmations share one refund ID and cannot spend the balance twice. The decision graph links the result, applicable policy and supporting evidence.

Refunds and pickup requests are **demo records only**. No payment gateway, courier API, email, or real transaction is invoked. The interface explicitly identifies this.

This is a local demo with one server-selected account (`DEMO_CUSTOMER_ID`, default `asha`), not a production authentication system. Before external deployment, supply real sign-in, derive customer identity from the authenticated session, restrict Studio/default developer APIs, and add operational controls. Naming another customer in chat cannot change tool scope.

## Seed and inspect

`bun run seed` adds namespaced sample data without deleting unrelated Aura data or resetting customer actions. Initial dates are relative to the first seed run. Re-seeding preserves existing orders and actions; it does not make an already used demo order refundable again. Graph queries and a presentation walkthrough are in [docs/demo.md](docs/demo.md).

```sh
bun run check
bun run test
bun run build
bun run smoke # with the dev server running
```

Tests include live Aura integration and require `.env`; they create uniquely identified test records and remove those records afterward. Stop the dev server before running a build, as required by Mastra.
