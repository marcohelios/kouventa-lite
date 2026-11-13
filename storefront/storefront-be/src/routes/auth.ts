// src/routes/auth.ts
import { FastifyPluginAsync } from "fastify";
import { hashPassword, verifyPassword } from "../utils/password";
import { prisma } from '../../server'; 

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get("/auth/me", { preHandler: [app.authenticate] }, async (request, reply) => {
    const payload = request.user as { sub: string; email: string; role: string };
    return reply.send({ user: payload });
  });

  app.post("/auth/logout", async (request, reply) => {
    reply.clearCookie("token", { path: "/" });
    return reply.send({ success: true });
});

  app.post("/auth/register", async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string };

    if (!email || !password || password.length < 8) {
      return reply.code(400).send({ error: "Invalid email or password too short" });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return reply.code(409).send({ error: "Email already registered" });
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: { email, passwordHash },
      select: { id: true, email: true, role: true },
    });

    const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role });
    reply.setCookie("token", token, { httpOnly: true, path: "/", sameSite: "lax" });
    return reply.send({ user });
  });

  app.post("/auth/login", async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string };

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !(await verifyPassword(user.passwordHash, password))) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }

    const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role });
    reply.setCookie("token", token, { httpOnly: true, path: "/", sameSite: "lax" });
    return reply.send({ user: { id: user.id, email: user.email, role: user.role } });
  });
};
