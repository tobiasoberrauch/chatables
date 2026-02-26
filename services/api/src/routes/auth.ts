import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { validate } from '../middleware/validation';
import {
  authenticate,
  signTokenPair,
  verifyRefreshToken,
} from '../middleware/auth';
import type { UserRole, ApiError } from '../../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAuthRouter(pool: Pool, redis: Redis): Router {
  const router = Router();

  // Refresh token TTL in seconds (matches REFRESH_TOKEN_EXPIRY default of 7 days)
  const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60;

  // -----------------------------------------------------------------------
  // Schemas
  // -----------------------------------------------------------------------

  const loginBodySchema = z.object({
    email: z.string().email(),
    password: z.string().min(8).max(128),
  });

  const refreshBodySchema = z.object({
    refreshToken: z.string().min(1),
  });

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function sendError(
    res: Response,
    req: Request,
    code: string,
    message: string,
    status: number,
  ): void {
    const error: ApiError = {
      code,
      message,
      requestId: req.requestId ?? 'unknown',
      timestamp: new Date().toISOString(),
    };
    res.status(status).json(error);
  }

  /**
   * Store a refresh token in Redis so we can:
   *   1. Quickly check validity without hitting the DB.
   *   2. Revoke tokens on logout.
   */
  async function storeRefreshToken(userId: string, token: string): Promise<void> {
    await redis.set(`refresh:${token}`, userId, 'EX', REFRESH_TOKEN_TTL);
  }

  async function revokeRefreshToken(token: string): Promise<void> {
    await redis.del(`refresh:${token}`);
  }

  async function isRefreshTokenValid(token: string): Promise<boolean> {
    const exists = await redis.exists(`refresh:${token}`);
    return exists === 1;
  }

  // -----------------------------------------------------------------------
  // POST /api/v1/auth/login
  // Authenticate with email + password, returns JWT + refresh token
  // -----------------------------------------------------------------------

  router.post(
    '/login',
    validate({ body: loginBodySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { email, password } = req.body as z.infer<typeof loginBodySchema>;

        const result = await pool.query(
          'SELECT id, email, password_hash, role, display_name FROM users WHERE email = $1',
          [email],
        );

        if (result.rows.length === 0) {
          sendError(res, req, 'AUTH_FAILED', 'Invalid email or password', 401);
          return;
        }

        const user = result.rows[0];
        const passwordValid = await bcrypt.compare(password, user.password_hash);

        if (!passwordValid) {
          sendError(res, req, 'AUTH_FAILED', 'Invalid email or password', 401);
          return;
        }

        const tokens = signTokenPair({
          sub: user.id,
          email: user.email,
          role: user.role as UserRole,
        });

        // Persist refresh token in Redis
        await storeRefreshToken(user.id, tokens.refreshToken);

        // Update last login timestamp
        await pool.query(
          'UPDATE users SET last_login_at = NOW() WHERE id = $1',
          [user.id],
        );

        res.json({
          data: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresIn: tokens.expiresIn,
            user: {
              id: user.id,
              email: user.email,
              role: user.role,
              displayName: user.display_name,
            },
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // POST /api/v1/auth/refresh
  // Exchange a valid refresh token for a new access + refresh token pair.
  // The old refresh token is revoked (rotation).
  // -----------------------------------------------------------------------

  router.post(
    '/refresh',
    validate({ body: refreshBodySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { refreshToken } = req.body as z.infer<typeof refreshBodySchema>;

        // Verify the JWT signature + expiry
        let payload: { sub: string; type: string };
        try {
          payload = verifyRefreshToken(refreshToken);
        } catch {
          sendError(res, req, 'AUTH_INVALID', 'Invalid or expired refresh token', 401);
          return;
        }

        if (payload.type !== 'refresh') {
          sendError(res, req, 'AUTH_INVALID', 'Token is not a refresh token', 401);
          return;
        }

        // Check the token has not been revoked
        const valid = await isRefreshTokenValid(refreshToken);
        if (!valid) {
          sendError(res, req, 'AUTH_REVOKED', 'Refresh token has been revoked', 401);
          return;
        }

        // Look up the user to get current role (it may have changed)
        const userResult = await pool.query(
          'SELECT id, email, role, display_name FROM users WHERE id = $1',
          [payload.sub],
        );

        if (userResult.rows.length === 0) {
          sendError(res, req, 'AUTH_FAILED', 'User no longer exists', 401);
          return;
        }

        const user = userResult.rows[0];

        // Revoke old token (rotation)
        await revokeRefreshToken(refreshToken);

        // Issue new pair
        const tokens = signTokenPair({
          sub: user.id,
          email: user.email,
          role: user.role as UserRole,
        });

        await storeRefreshToken(user.id, tokens.refreshToken);

        res.json({
          data: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresIn: tokens.expiresIn,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // POST /api/v1/auth/logout
  // Invalidate the refresh token so it cannot be reused
  // -----------------------------------------------------------------------

  router.post(
    '/logout',
    authenticate,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { refreshToken } = req.body ?? {};

        if (refreshToken && typeof refreshToken === 'string') {
          await revokeRefreshToken(refreshToken);
        }

        // Optionally blacklist the access token for its remaining lifetime.
        // For stateless JWTs, clients should simply discard the token.
        // For extra security, store the jti in a Redis blacklist until exp.
        const accessToken = req.headers.authorization?.split(' ')[1];
        if (accessToken && req.user) {
          const ttl = req.user.exp - Math.floor(Date.now() / 1000);
          if (ttl > 0) {
            await redis.set(`blacklist:${accessToken}`, '1', 'EX', ttl);
          }
        }

        res.json({ data: { message: 'Logged out successfully' } });
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/v1/auth/me
  // Return the current user's profile
  // -----------------------------------------------------------------------

  router.get(
    '/me',
    authenticate,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = req.user!.sub;

        const result = await pool.query(
          `SELECT id, email, role, display_name, created_at, last_login_at
           FROM users WHERE id = $1`,
          [userId],
        );

        if (result.rows.length === 0) {
          sendError(res, req, 'NOT_FOUND', 'User not found', 404);
          return;
        }

        const user = result.rows[0];
        res.json({
          data: {
            id: user.id,
            email: user.email,
            role: user.role,
            displayName: user.display_name,
            createdAt: user.created_at,
            lastLoginAt: user.last_login_at,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
