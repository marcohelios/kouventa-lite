import { config } from "../config/config";
import { AzureChatOpenAI } from "@langchain/openai";

export const llm = new AzureChatOpenAI({
    model: config.openaiChatModel,
    azureOpenAIApiKey: config.azureOpenAIApiKey,
    azureOpenAIApiInstanceName: config.azureOpenAIApiInstanceName,
    azureOpenAIApiDeploymentName: config.azureOpenAIApiDeploymentName,
    azureOpenAIApiVersion: config.azureOpenAIApiVersion,
})
11