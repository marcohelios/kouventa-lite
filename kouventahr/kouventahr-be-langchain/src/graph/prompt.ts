export const ENTITY_SYSTEM_PROMPT = `You identify the entities in a user's question so they can be looked up in a knowledge graph.

An entity is any specific, nameable thing: a person, organization, document, law, product, place, event, system, process, or concept that the text treats as a distinct item.

Preferred entity types: {entityTypes}
The graph most likely contains these. Prioritise them, but also extract any other specific entity that clearly matters to the question.

Rules:
- Copy each name exactly as written in the question. Do not translate, correct or expand it.
- Return only specific things, never generic words like "information" or "rules" on their own.
- Do not invent names that are not in the question.
- If there are no entities, return an empty list.`;

export const ENTITY_HUMAN_PROMPT =
  "Extract the entities from this question: {question}";

export const GRAPH_EXTRA_INSTRUCTIONS = `
## Extra rules
- Node id: copy the entity's name exactly as written in the text, in the original language. Never translate.
- Node type: a short, general, singular label in English. Write multi-word types as separate Title Case words with spaces (for example "Regulatory Body"). Reuse the same type for the same kind of thing.
- Relationship type: UPPER_SNAKE_CASE with underscores and no spaces (for example IS_PART_OF). Use an active verb phrase.
- Direction matters: the source performs the action on the target.
- Use the same type for a node in the node list and inside relationships.
- Skip page numbers, headers, footers, and ceremonial or boilerplate text.
- Only extract specific, nameable entities. Do not create nodes for generic or abstract single words on their own (for example "risk", "supervision", "finance"). Keep the full specific term instead (for example "Risiko Kredit" or "Manajemen Risiko").
- Relationship type must be a verb phrase (REGULATES, HAS_POLICY), never a bare noun (RISK).
- Copy ids with their original spelling from the text.
`;