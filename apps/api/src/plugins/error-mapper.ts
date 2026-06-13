import fp from 'fastify-plugin';
import { ZodError } from 'zod';

/**
 * RFC 9457 `application/problem+json` error envelope.
 *
 * - ZodError → 422 validation_failed with field-level errors
 * - HTTP errors from @fastify/sensible → preserved status + code
 * - Anything else → 500 internal_error with a logged stack
 */
export const errorMapperPlugin = fp(async (app) => {
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;

    if (err instanceof ZodError) {
      reply
        .status(422)
        .type('application/problem+json')
        .send({
          type: 'https://api.trackflow.app/errors/validation',
          title: 'Validation failed',
          status: 422,
          code: 'validation_failed',
          detail: 'One or more fields are invalid',
          errors: err.issues.map((issue) => ({
            path: issue.path.join('.'),
            code: issue.code,
            message: issue.message,
          })),
          request_id: requestId,
        });
      return;
    }

    const e = err as { statusCode?: number; code?: string; message?: string };
    const statusCode = e.statusCode ?? 500;
    const code = e.code ?? 'internal_error';
    const message = e.message ?? 'Internal Server Error';

    if (statusCode >= 500) {
      req.log.error({ err, request_id: requestId }, 'request failed');
    } else {
      req.log.warn({ err, request_id: requestId }, 'request rejected');
    }

    reply
      .status(statusCode)
      .type('application/problem+json')
      .send({
        type: `https://api.trackflow.app/errors/${code}`,
        title: message,
        status: statusCode,
        code,
        detail:
          statusCode >= 500 && process.env.NODE_ENV === 'production'
            ? 'An unexpected error occurred. The error has been logged.'
            : message,
        request_id: requestId,
      });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).type('application/problem+json').send({
      type: 'https://api.trackflow.app/errors/not_found',
      title: 'Not Found',
      status: 404,
      code: 'not_found',
      detail: `No route for ${req.method} ${req.url}`,
      request_id: req.id,
    });
  });
});
