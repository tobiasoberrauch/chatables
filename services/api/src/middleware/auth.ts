import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type { JWTPayload, UserRole, ApiError } from '../../../../shared/src/types/instrument';

// ---------------------------------------------------------------------------
// Environment / config
// ---------------------------------------------------------------------------

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'change-me-refresh-in-production';
const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY ?? '15m';
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY ?? '7d';

// ---------------------------------------------------------------------------
// Augment Express Request so downstream handlers can access `req.user`
// ---------------------------------------------------------------------------

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
      requestId?: string;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApiError(
  code: string,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ApiError {
  return {
    code,
    message,
    details,
    requestId,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Token generation utilities
// ---------------------------------------------------------------------------

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds until access token expiry
}

/**
 * Sign a new access + refresh token pair for the given user claims.
 */
export function signTokenPair(payload: Pick<JWTPayload, 'sub' | 'email' | 'role'>): TokenPair {
  const accessToken = jwt.sign(
    { sub: payload.sub, email: payload.email, role: payload.role },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY },
  );

  const refreshToken = jwt.sign(
    { sub: payload.sub, type: 'refresh' },
    JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY },
  );

  // Decode to read the computed `exp` so we can return seconds-until-expiry
  const decoded = jwt.decode(accessToken) as JWTPayload;
  const expiresIn = decoded.exp - Math.floor(Date.now() / 1000);

  return { accessToken, refreshToken, expiresIn };
}

/**
 * Verify an access token and return its payload.
 * Throws on invalid / expired tokens.
 */
export function verifyAccessToken(token: string): JWTPayload {
  return jwt.verify(token, JWT_SECRET) as JWTPayload;
}

/**
 * Verify a refresh token and return its payload.
 * Throws on invalid / expired tokens.
 */
export function verifyRefreshToken(token: string): { sub: string; type: string } {
  return jwt.verify(token, JWT_REFRESH_SECRET) as { sub: string; type: string };
}

// ---------------------------------------------------------------------------
// Middleware: authenticate
// ---------------------------------------------------------------------------

/**
 * JWT authentication middleware.
 *
 * Extracts the Bearer token from the Authorization header, verifies it, and
 * attaches the decoded payload to `req.user`. Responds with 401 on missing or
 * invalid tokens.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.requestId ?? 'unknown';
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json(
      buildApiError('AUTH_MISSING', 'Authorization header is required', requestId),
    );
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    res.status(401).json(
      buildApiError('AUTH_MALFORMED', 'Authorization header must use Bearer scheme', requestId),
    );
    return;
  }

  const token = parts[1];

  try {
    const payload = verifyAccessToken(token);
    req.user = payload;
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      res.status(401).json(
        buildApiError('AUTH_EXPIRED', 'Access token has expired', requestId),
      );
      return;
    }
    res.status(401).json(
      buildApiError('AUTH_INVALID', 'Invalid access token', requestId),
    );
  }
}

// ---------------------------------------------------------------------------
// Middleware: requireRole  (RBAC)
// ---------------------------------------------------------------------------

/**
 * Role hierarchy: admin > analyst > viewer.
 * Higher roles implicitly satisfy lower-role requirements.
 */
const ROLE_HIERARCHY: Record<UserRole, number> = {
  viewer: 0,
  analyst: 1,
  admin: 2,
} as const;

/**
 * Factory that returns middleware enforcing a minimum required role.
 *
 * Must be placed *after* `authenticate` in the middleware chain so that
 * `req.user` is populated.
 *
 * Usage:
 *   router.delete('/items/:id', authenticate, requireRole('admin'), handler);
 */
export function requireRole(...allowedRoles: UserRole[]): RequestHandler {
  // Precompute the minimum hierarchy level required
  const minLevel = Math.min(...allowedRoles.map((r) => ROLE_HIERARCHY[r]));

  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = req.requestId ?? 'unknown';

    if (!req.user) {
      res.status(401).json(
        buildApiError('AUTH_REQUIRED', 'Authentication is required', requestId),
      );
      return;
    }

    const userLevel = ROLE_HIERARCHY[req.user.role as UserRole];
    if (userLevel === undefined || userLevel < minLevel) {
      res.status(403).json(
        buildApiError(
          'FORBIDDEN',
          `Insufficient permissions. Required role: ${allowedRoles.join(' | ')}`,
          requestId,
          { requiredRoles: allowedRoles, currentRole: req.user.role },
        ),
      );
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Optional: soft authentication (attaches user if token present, does not reject)
// ---------------------------------------------------------------------------

/**
 * Like `authenticate` but does not reject requests lacking a token.
 * Useful for endpoints that behave differently for authenticated vs anonymous users.
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    next();
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    next();
    return;
  }

  try {
    req.user = verifyAccessToken(parts[1]);
  } catch {
    // Silently ignore invalid tokens — request proceeds as unauthenticated
  }

  next();
}
