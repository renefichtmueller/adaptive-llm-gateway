import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { classifyInput } from '../pipeline/pre-classifier.js';

const ClassifyRequestSchema = z.object({
  input: z.string().min(1).max(10_000),
  caller: z.string().min(1).max(100).optional().default('internal'),
});

type ClassifyRequest = z.infer<typeof ClassifyRequestSchema>;

export async function classifyRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/classify',
    async (request: FastifyRequest, reply: FastifyReply) => {
      let body: ClassifyRequest;
      try {
        body = ClassifyRequestSchema.parse(request.body);
      } catch (err) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: err instanceof z.ZodError ? err.errors[0]?.message : 'Invalid request body',
        });
      }

      const startMs = Date.now();
      const result = await classifyInput(body.input);
      const latencyMs = Date.now() - startMs;

      return reply.send({
        ...result,
        latency_ms: latencyMs,
        model_used: 'qwen2.5:3b',
      });
    },
  );
}
