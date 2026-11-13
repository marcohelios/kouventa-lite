import type { FastifyInstance } from 'fastify';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { GraphRecursionError } from '@langchain/langgraph';
import { config } from '../config/config';
import * as db from '../db';
import { sendSse, startSse } from '../sse';
import { getAgent } from './agent';
import { SEARCH_DOCUMENTS, type DocumentSource } from './builtinTools';

interface AgentBody {
  message: string;
  sessionId?: string;
}

const RESULT_PREVIEW_CHARS = 500;

const preview = (content: unknown): string => {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return text.length > RESULT_PREVIEW_CHARS ? `${text.slice(0, RESULT_PREVIEW_CHARS)}…` : text;
};

/** True for LangGraph's recursion-limit error, even when middleware has wrapped it in another error. */
const isStepLimitError = (error: unknown): boolean => {
  for (let e = error as any, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e instanceof GraphRecursionError || e.name === 'GraphRecursionError') return true;
    if (e.lc_error_code === 'GRAPH_RECURSION_LIMIT') return true;
  }
  return false;
};

/** Text of a streamed model chunk; tool-call chunks carry no text. */
const chunkText = (message: BaseMessage): string => {
  const { content } = message;
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' && 'text' in part ? String(part.text) : '')).join('');
};

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: AgentBody }>('/api/agent', async (request, reply) => {
    const { message, sessionId } = request.body ?? ({} as AgentBody);
    if (!message) return reply.status(400).send({ error: 'Message is required' });

    const tenantId = request.tenant.id;
    const threadId =
      sessionId && (await db.sessionExists(tenantId, sessionId)) ? sessionId : await db.createSession(tenantId);

    startSse(reply);
    sendSse(reply, { type: 'meta', sessionId: threadId });

    // Stop the run (and any in-flight tool calls) when the browser goes away.
    const abort = new AbortController();
    reply.raw.on('close', () => abort.abort());

    const sources = new Map<string, DocumentSource>();
    const toolNames = new Map<string, string>();
    let answer = '';

    try {
      const stream = await (await getAgent(request.tenant)).stream(
        { messages: [{ role: 'user', content: message }] },
        {
          configurable: { thread_id: threadId },
          streamMode: ['messages', 'updates'],
          subgraphs: true,
          recursionLimit: config.agentRecursionLimit,
          signal: abort.signal,
        }
      );

      for await (const [namespace, mode, data] of stream as AsyncIterable<[string[], string, any]>) {
        const isTopLevel = namespace.length === 0;

        if (mode === 'messages') {
          // Only the top-level agent's tokens are the answer; sub-agent output is internal.
          // With subgraphs on, the top-level model node streams under ["model_request:<id>"];
          // a sub-agent's is nested deeper (under the "tools:<id>" task that spawned it).
          const [msg] = data as [BaseMessage];
          const isTopLevelModel = namespace.length === 1 && namespace[0].startsWith('model_request');
          if (!isTopLevelModel || !AIMessage.isInstance(msg)) continue;
          const text = chunkText(msg);
          if (text) {
            answer += text;
            sendSse(reply, { type: 'chunk', content: text });
          }
          continue;
        }

        // mode === 'updates': { [node]: stateUpdate | null }
        for (const update of Object.values(data as Record<string, any>)) {
          if (!update) continue;

          if (Array.isArray(update.todos)) sendSse(reply, { type: 'todos', items: update.todos });

          for (const msg of (update.messages ?? []) as BaseMessage[]) {
            if (AIMessage.isInstance(msg)) {
              for (const call of msg.tool_calls ?? []) {
                if (!call.id) continue;
                toolNames.set(call.id, call.name);
                sendSse(reply, { type: 'tool_start', id: call.id, name: call.name, args: call.args, subagent: !isTopLevel });
              }
            } else if (ToolMessage.isInstance(msg)) {
              const name = msg.name ?? toolNames.get(msg.tool_call_id) ?? 'tool';
              if (name === SEARCH_DOCUMENTS && Array.isArray(msg.artifact)) {
                for (const s of msg.artifact as DocumentSource[]) sources.set(s.documentId, s);
              }
              sendSse(reply, {
                type: 'tool_end',
                id: msg.tool_call_id,
                name,
                result: preview(msg.content),
                isError: msg.status === 'error',
                subagent: !isTopLevel,
              });
            }
          }
        }
      }

      if (answer) await db.saveMessages(tenantId, threadId, message, answer);
      sendSse(reply, { type: 'done', sources: [...sources.values()] });
    } catch (error) {
      if (abort.signal.aborted) return;

      if (isStepLimitError(error)) {
        // The agent ran out of steps while still working. Keep what it already said and explain.
        request.log.warn({ limit: config.agentRecursionLimit }, 'Agent hit the step limit');
        if (answer) await db.saveMessages(tenantId, threadId, message, answer);
        sendSse(reply, {
          type: 'error',
          content: `Stopped after reaching the step limit (${config.agentRecursionLimit} steps). Try a narrower question.`,
        });
        sendSse(reply, { type: 'done', sources: [...sources.values()] });
      } else {
        request.log.error(error, 'Error in agent endpoint');
        sendSse(reply, { type: 'error', content: 'Agent run failed.' });
      }
    } finally {
      reply.raw.end();
    }
  });
}
