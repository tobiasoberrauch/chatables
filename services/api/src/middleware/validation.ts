import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodSchema, ZodError, ZodIssue } from 'zod';
import type { ApiError } from '../../../../shared/src/types/instrument';

/**
 * Specifies which parts of the request to validate.
 * Each field maps to a Zod schema that validates that portion of the request.
 */
interface ValidationSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Transforms Zod issues into a structured details map suitable for API error responses.
 */
function formatZodErrors(issues: ZodIssue[]): Record<string, unknown> {
  const fieldErrors: Record<string, string[]> = {};

  for (const issue of issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '_root';
    if (!fieldErrors[path]) {
      fieldErrors[path] = [];
    }
    fieldErrors[path].push(issue.message);
  }

  return { fieldErrors };
}

/**
 * Request validation middleware factory.
 *
 * Validates `req.body`, `req.query`, and/or `req.params` against the provided
 * Zod schemas. On validation failure, responds with a 400 and structured error
 * payload conforming to the ApiError type.
 *
 * On success, the validated (and potentially transformed/coerced) values are
 * written back onto the request so downstream handlers receive clean data.
 *
 * Usage:
 *   router.post('/items', validate({ body: createItemSchema }), handler);
 *   router.get('/items', validate({ query: listQuerySchema }), handler);
 *   router.get('/items/:id', validate({ params: idParamSchema }), handler);
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: ZodIssue[] = [];

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) {
        for (const issue of result.error.issues) {
          issue.path = ['params', ...issue.path];
          errors.push(issue);
        }
      } else {
        req.params = result.data;
      }
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) {
        for (const issue of result.error.issues) {
          issue.path = ['query', ...issue.path];
          errors.push(issue);
        }
      } else {
        // Write parsed query back — Zod may have coerced or defaulted values
        (req as any).validatedQuery = result.data;
      }
    }

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) {
        for (const issue of result.error.issues) {
          issue.path = ['body', ...issue.path];
          errors.push(issue);
        }
      } else {
        req.body = result.data;
      }
    }

    if (errors.length > 0) {
      const requestId = (req as any).requestId ?? 'unknown';
      const apiError: ApiError = {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: formatZodErrors(errors),
        requestId,
        timestamp: new Date().toISOString(),
      };
      res.status(400).json(apiError);
      return;
    }

    next();
  };
}

/**
 * Helper to extract validated query from the request.
 * Prefer this over raw req.query to get properly typed/coerced values.
 */
export function validatedQuery<T>(req: Request): T {
  return (req as any).validatedQuery as T;
}
