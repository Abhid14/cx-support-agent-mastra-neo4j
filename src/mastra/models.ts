// Azure routes by deployment name, which can differ from the underlying model ID.
export const azureDeployment =
  process.env.AZURE_OPENAI_DEPLOYMENT?.trim() || "gpt-6-luna";
export const agentModel = `azure-openai/${azureDeployment}` as const;
