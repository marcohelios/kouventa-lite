import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "jsonwebtoken";
import "dotenv/config";
import { agent } from "./agent";

const JWT_SECRET = process.env.JWT_SECRET!; // must match storefront-be's .env exactly

const fastify = Fastify({ logger: true });

fastify.register(cors, {
  origin: /^http:\/\/localhost:\d+$/,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: true, // required so the browser actually sends the token cookie
});

fastify.register(cookie);

interface AuthPayload {
  sub: string;
  email: string;
  role: "NORMAL" | "PREMIUM";
}

async function requirePremium(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies?.token;
  if (!token) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
    if (payload.role !== "PREMIUM") {
      return reply.code(403).send({ error: "Forbidden" });
    }
    (request as any).user = payload; // attach for the route handler to use if needed
  } catch {
    return reply.code(401).send({ error: "Unauthorized" });
  }
}

interface AgentRequestBody {
  message: string;
}

fastify.post(
  "/api/agent/chat",
  { preHandler: [requirePremium] },
  async (request, reply) => {
    const { message } = request.body as AgentRequestBody;

    if (!message) {
      return reply.status(400).send({ error: "message is required" });
    }

    try {
        const result = await agent.invoke({
        messages: [{ role: "user", content: message }],
        });

        const lastMessage = result.messages[result.messages.length - 1];

        if (!lastMessage) {
        return reply.status(500).send({ error: "Agent returned no response" });
        }
        return { response: lastMessage.content };
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Agent invocation failed" });
    }
  }
);

const start = async () => {
  try {
    await fastify.listen({ port: 3003 }); // matches the port your frontend CORS already allows
    console.log("Agent service running on http://localhost:3003");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();