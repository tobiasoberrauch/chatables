/**
 * Auth Middleware -- Unit Tests
 *
 * Tests JWT token generation, verification, expiry, and Express middleware
 * (authenticate, requireRole) with mocked request/response objects.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  signTokenPair,
  verifyAccessToken,
  verifyRefreshToken,
  authenticate,
  requireRole,
} from '../src/middleware/auth';
import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Helper: create mock Express request/response/next
// ---------------------------------------------------------------------------

function mockRequest(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    requestId: 'test-req-001',
    ...overrides,
  } as unknown as Request;
}

function mockResponse(): Response & { _status: number; _json: any } {
  const res: any = {
    _status: 0,
    _json: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: any) {
      res._json = data;
      return res;
    },
  };
  return res;
}

function mockNext(): NextFunction & { called: boolean } {
  const fn: any = () => {
    fn.called = true;
  };
  fn.called = false;
  return fn;
}

// ============================================================================
// Token Generation
// ============================================================================

describe('signTokenPair', () => {
  let tokens: ReturnType<typeof signTokenPair>;

  beforeAll(() => {
    tokens = signTokenPair({
      sub: 'user-001',
      email: 'analyst@terminal.io',
      role: 'analyst' as const,
    });
  });

  it('generates valid JWT access and refresh tokens', () => {
    expect(tokens.accessToken).toBeDefined();
    expect(tokens.refreshToken).toBeDefined();
    expect(typeof tokens.accessToken).toBe('string');
    expect(typeof tokens.refreshToken).toBe('string');
    // JWTs have 3 dot-separated parts
    expect(tokens.accessToken.split('.')).toHaveLength(3);
    expect(tokens.refreshToken.split('.')).toHaveLength(3);
  });

  it('returns a positive expiresIn value', () => {
    expect(tokens.expiresIn).toBeGreaterThan(0);
  });

  it('expiresIn matches the delta between exp and now', () => {
    const payload = verifyAccessToken(tokens.accessToken);
    const expectedDelta = payload.exp - Math.floor(Date.now() / 1000);
    // Allow 2 seconds of clock skew
    expect(Math.abs(tokens.expiresIn - expectedDelta)).toBeLessThanOrEqual(2);
  });
});

// ============================================================================
// Access Token Verification
// ============================================================================

describe('verifyAccessToken', () => {
  it('returns payload with correct claims for a valid token', () => {
    const tokens = signTokenPair({
      sub: 'user-002',
      email: 'admin@terminal.io',
      role: 'admin' as const,
    });

    const payload = verifyAccessToken(tokens.accessToken);

    expect(payload.sub).toBe('user-002');
    expect(payload.email).toBe('admin@terminal.io');
    expect(payload.role).toBe('admin');
    expect(payload.iat).toBeDefined();
    expect(payload.exp).toBeDefined();
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it('throws on a completely invalid token', () => {
    expect(() => verifyAccessToken('not.a.token')).toThrow();
  });

  it('throws on a tampered token', () => {
    const tokens = signTokenPair({
      sub: 'user-003',
      email: 'viewer@terminal.io',
      role: 'viewer' as const,
    });

    const parts = tokens.accessToken.split('.');
    parts[1] = parts[1] + 'TAMPERED';
    const tampered = parts.join('.');

    expect(() => verifyAccessToken(tampered)).toThrow();
  });

  it('throws on an expired token', () => {
    // Create a token that is already expired
    const secret = process.env.JWT_SECRET ?? 'change-me-in-production';
    const expiredToken = jwt.sign(
      { sub: 'user-expired', email: 'expired@terminal.io', role: 'viewer' },
      secret,
      { expiresIn: -10 }, // Already expired 10 seconds ago
    );

    expect(() => verifyAccessToken(expiredToken)).toThrow();
  });
});

// ============================================================================
// Refresh Token Verification
// ============================================================================

describe('verifyRefreshToken', () => {
  it('verifies a valid refresh token', () => {
    const tokens = signTokenPair({
      sub: 'user-004',
      email: 'test@terminal.io',
      role: 'viewer' as const,
    });

    const payload = verifyRefreshToken(tokens.refreshToken);
    expect(payload.sub).toBe('user-004');
    expect(payload.type).toBe('refresh');
  });

  it('rejects an access token used as a refresh token', () => {
    const tokens = signTokenPair({
      sub: 'user-005',
      email: 'test2@terminal.io',
      role: 'analyst' as const,
    });

    // Access token was signed with JWT_SECRET, refresh expects JWT_REFRESH_SECRET
    expect(() => verifyRefreshToken(tokens.accessToken)).toThrow();
  });
});

// ============================================================================
// authenticate middleware
// ============================================================================

describe('authenticate middleware', () => {
  it('responds 401 when Authorization header is missing', () => {
    const req = mockRequest({ headers: {} });
    const res = mockResponse();
    const next = mockNext();

    authenticate(req, res, next);

    expect(res._status).toBe(401);
    expect(res._json.code).toBe('AUTH_MISSING');
    expect(next.called).toBe(false);
  });

  it('responds 401 when Authorization header is malformed (not Bearer)', () => {
    const req = mockRequest({
      headers: { authorization: 'Basic abc123' },
    });
    const res = mockResponse();
    const next = mockNext();

    authenticate(req, res, next);

    expect(res._status).toBe(401);
    expect(res._json.code).toBe('AUTH_MALFORMED');
    expect(next.called).toBe(false);
  });

  it('responds 401 for an invalid token', () => {
    const req = mockRequest({
      headers: { authorization: 'Bearer invalid.token.here' },
    });
    const res = mockResponse();
    const next = mockNext();

    authenticate(req, res, next);

    expect(res._status).toBe(401);
    expect(res._json.code).toBe('AUTH_INVALID');
    expect(next.called).toBe(false);
  });

  it('responds 401 with AUTH_EXPIRED for an expired token', () => {
    const secret = process.env.JWT_SECRET ?? 'change-me-in-production';
    const expiredToken = jwt.sign(
      { sub: 'user-expired', email: 'expired@terminal.io', role: 'viewer' },
      secret,
      { expiresIn: -10 },
    );

    const req = mockRequest({
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    const res = mockResponse();
    const next = mockNext();

    authenticate(req, res, next);

    expect(res._status).toBe(401);
    expect(res._json.code).toBe('AUTH_EXPIRED');
    expect(next.called).toBe(false);
  });

  it('sets req.user and calls next() for a valid token', () => {
    const tokens = signTokenPair({
      sub: 'user-valid',
      email: 'valid@terminal.io',
      role: 'analyst' as const,
    });

    const req = mockRequest({
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    const res = mockResponse();
    const next = mockNext();

    authenticate(req, res, next);

    expect(next.called).toBe(true);
    expect(req.user).toBeDefined();
    expect(req.user!.sub).toBe('user-valid');
    expect(req.user!.email).toBe('valid@terminal.io');
    expect(req.user!.role).toBe('analyst');
  });
});

// ============================================================================
// requireRole middleware
// ============================================================================

describe('requireRole middleware', () => {
  it('responds 401 when req.user is not set', () => {
    const middleware = requireRole('admin');
    const req = mockRequest(); // No user
    const res = mockResponse();
    const next = mockNext();

    middleware(req, res, next);

    expect(res._status).toBe(401);
    expect(res._json.code).toBe('AUTH_REQUIRED');
    expect(next.called).toBe(false);
  });

  it('responds 403 when viewer tries to access admin-only route', () => {
    const middleware = requireRole('admin');
    const req = mockRequest();
    req.user = {
      sub: 'user-viewer',
      email: 'viewer@terminal.io',
      role: 'viewer' as any,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    };
    const res = mockResponse();
    const next = mockNext();

    middleware(req, res, next);

    expect(res._status).toBe(403);
    expect(res._json.code).toBe('FORBIDDEN');
    expect(next.called).toBe(false);
  });

  it('responds 403 when analyst tries to access admin-only route', () => {
    const middleware = requireRole('admin');
    const req = mockRequest();
    req.user = {
      sub: 'user-analyst',
      email: 'analyst@terminal.io',
      role: 'analyst' as any,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    };
    const res = mockResponse();
    const next = mockNext();

    middleware(req, res, next);

    expect(res._status).toBe(403);
    expect(res._json.code).toBe('FORBIDDEN');
    expect(next.called).toBe(false);
  });

  it('passes when admin accesses admin-only route', () => {
    const middleware = requireRole('admin');
    const req = mockRequest();
    req.user = {
      sub: 'user-admin',
      email: 'admin@terminal.io',
      role: 'admin' as any,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    };
    const res = mockResponse();
    const next = mockNext();

    middleware(req, res, next);

    expect(next.called).toBe(true);
    expect(res._status).toBe(0); // No error response
  });

  it('passes when admin accesses viewer-level route (role hierarchy)', () => {
    const middleware = requireRole('viewer');
    const req = mockRequest();
    req.user = {
      sub: 'user-admin',
      email: 'admin@terminal.io',
      role: 'admin' as any,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    };
    const res = mockResponse();
    const next = mockNext();

    middleware(req, res, next);

    expect(next.called).toBe(true);
  });

  it('passes when analyst accesses analyst-level route', () => {
    const middleware = requireRole('analyst');
    const req = mockRequest();
    req.user = {
      sub: 'user-analyst',
      email: 'analyst@terminal.io',
      role: 'analyst' as any,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    };
    const res = mockResponse();
    const next = mockNext();

    middleware(req, res, next);

    expect(next.called).toBe(true);
  });

  it('passes when analyst accesses viewer-level route (role hierarchy)', () => {
    const middleware = requireRole('viewer');
    const req = mockRequest();
    req.user = {
      sub: 'user-analyst',
      email: 'analyst@terminal.io',
      role: 'analyst' as any,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    };
    const res = mockResponse();
    const next = mockNext();

    middleware(req, res, next);

    expect(next.called).toBe(true);
  });
});

// ============================================================================
// Token creation for all roles
// ============================================================================

describe('Token roles', () => {
  it('creates tokens with correct roles for all user types', () => {
    const roles = ['viewer', 'analyst', 'admin'] as const;

    for (const role of roles) {
      const tokens = signTokenPair({
        sub: `user-${role}`,
        email: `${role}@terminal.io`,
        role,
      });

      const payload = verifyAccessToken(tokens.accessToken);
      expect(payload.role).toBe(role);
    }
  });
});
