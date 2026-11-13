import { z } from "zod";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { llm } from "./llm";
import { ENTITY_HUMAN_PROMPT, ENTITY_SYSTEM_PROMPT } from "./prompt";

const schema = z.object({
    names: z
    .array(z.string())
    .describe("Names of all specific entities mentioned in the text, copied exactly as written.")
});

const prompt = ChatPromptTemplate.fromMessages([
    ["system", ENTITY_SYSTEM_PROMPT],
    ["human", ENTITY_HUMAN_PROMPT]
])

export const entityChain = prompt.pipe(llm.withStructuredOutput(schema))