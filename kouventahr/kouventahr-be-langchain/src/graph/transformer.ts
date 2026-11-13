import { ChatPromptTemplate } from "@langchain/core/prompts";
import {
  LLMGraphTransformer,
  SYSTEM_PROMPT,
} from "@langchain/community/experimental/graph_transformers/llm";
import { llm } from "./llm";
import { GRAPH_EXTRA_INSTRUCTIONS } from "./prompt";

const FORBIDDEN = /[{}"'`$\\<>]/; // Not allowed string that might break the node and relationship

/** Node types are kept exactly as typed (so "POJK" stays "POJK"); duplicates ignore case. */
export function sanitizeNodeTypes(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const cleaned = raw.trim().replace(/\s+/g, " ");
    if (!cleaned || FORBIDDEN.test(cleaned)) continue;
    if (!/^[\p{L}\p{N} ]+$/u.test(cleaned)) continue; // letters, digits, single spaces only

    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

export function sanitizeRelTypes(list: string[]): string[] {
  const out = new Set<string>();
  for (const raw of list) {
    const cleaned = raw.trim();
    if (!cleaned || FORBIDDEN.test(cleaned)) continue;

    const snake = cleaned
      .replace(/[\s-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase();
    if (!snake || !/^[\p{L}\p{N}_]+$/u.test(snake)) continue;
    out.add(snake);
  }
  return [...out];
}

export function buildTransformer(
  userNodes: string[] = [],
  userRels: string[] = []
) {
  const nodes = sanitizeNodeTypes(userNodes);
  const rels = sanitizeRelTypes(userRels);

  const parts: string[] = [SYSTEM_PROMPT, GRAPH_EXTRA_INSTRUCTIONS];

  if (nodes.length) {
    parts.push(
      `## Preferred node types\nUse one of these whenever it fits: ${nodes.join(", ")}.\n` +
        `If none fits an entity that matters, you may create a new type, but first check whether a preferred or broader type already covers it.`
    );
  }
  if (rels.length) {
    parts.push(
      `## Preferred relationship types\nUse one of these whenever it fits: ${rels.join(", ")}.\n` +
        `If none fits, you may add a new one, but prefer a specific verb over a vague one like RELATED_TO.`
    );
  }

  const systemText = parts.join("\n");

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", systemText],
    [
      "human",
      "Tip: Make sure to answer in the correct format and do not include any explanations. Use the given format to extract information from the following input: {input}",
    ],
  ]);

  return new LLMGraphTransformer({
    llm,
    prompt,
    fallbackRelationshipType: "RELATED_TO",
  });
}