import { AzureChatOpenAI } from '@langchain/openai';
import { config } from '../config/config';

/**
 * Chat model for the agent: the same Azure deployment as graph/llm.ts, with reasoning switched off.
 * The deployment is a reasoning model, and /v1/chat/completions rejects function tools while
 * reasoning is enabled ("use /v1/responses or set reasoning_effort to 'none'"). The Responses API
 * returned 404 for this deployment/api-version, so tool calling takes priority over reasoning here.
 * Revisit once the deployment is reachable on /responses (then use `useResponsesApi: true`).
 */
export const agentModel = new AzureChatOpenAI({
  model: config.openaiChatModel,
  azureOpenAIApiKey: config.azureOpenAIApiKey,
  azureOpenAIApiInstanceName: config.azureOpenAIApiInstanceName,
  azureOpenAIApiDeploymentName: config.azureOpenAIApiDeploymentName,
  azureOpenAIApiVersion: config.azureOpenAIApiVersion,
  reasoning: { effort: 'none' },
});
