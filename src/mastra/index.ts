import { Mastra } from "@mastra/core/mastra";
import { AzureOpenAIGateway } from "@mastra/core/llm";
import { MastraCompositeStore } from "@mastra/core/storage";
import { agent } from "./agents/agent";
import { azureDeployment } from "./models";
import { supportTools } from "./support/tools";
import { neo4jMemory } from "./support/memory";
import { supportRoutes } from "./support/routes";

export const mastra = new Mastra({
  gateways: {
    azure: new AzureOpenAIGateway({
      resourceName: process.env.AZURE_RESOURCE_NAME?.trim() || "",
      apiKey: process.env.AZURE_API_KEY?.trim(),
      apiVersion: "v1",
      useResponsesAPI: true,
      deployments: [azureDeployment],
    }),
  },
  server: { apiRoutes: supportRoutes },
  agents: { agent },
  tools: supportTools,
  storage: new MastraCompositeStore({
    id: "neo4j-support-storage",
    domains: { memory: neo4jMemory },
  }),
});
