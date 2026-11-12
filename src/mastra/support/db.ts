import neo4j, { type ManagedTransaction } from "neo4j-driver";

export const namespace = "sxp-support-demo-v1";
export const customerId = process.env.DEMO_CUSTOMER_ID || "asha";
let driver: ReturnType<typeof neo4j.driver> | undefined;
export function getDriver() {
  if (!driver) {
    const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD } = process.env;
    if (!NEO4J_URI || !NEO4J_USERNAME || !NEO4J_PASSWORD)
      throw new Error("Neo4j credentials are required");
    driver = neo4j.driver(
      NEO4J_URI,
      neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD),
      { disableLosslessIntegers: true },
    );
  }
  return driver;
}
export async function query(
  cypher: string,
  params: Record<string, unknown> = {},
) {
  const result = await getDriver().executeQuery(
    cypher,
    { ns: namespace, customerId, ...params },
    { database: process.env.NEO4J_DATABASE || "neo4j" },
  );
  return result.records.map((r) => r.toObject());
}
export async function transaction<T>(
  work: (tx: ManagedTransaction) => Promise<T>,
) {
  const session = getDriver().session({
    database: process.env.NEO4J_DATABASE || "neo4j",
  });
  try {
    return await session.executeWrite(work);
  } finally {
    await session.close();
  }
}
export async function closeDatabase() {
  await driver?.close();
  driver = undefined;
}
