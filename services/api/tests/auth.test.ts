import { describe, it, expect, beforeAll } from 'vitest';
import {
  signTokenPair,
  verifyAccessToken,
  verifyRefreshToken,
} from '../src/middleware/auth';

/**
 * Auth Middleware Tests
 *
 * Tests JWT token generation, verification, expiry, and role-based access.
 */

describe('Auth: Token Generation', () => {
  let tokens: ReturnType<typeof signTokenPair>;

  beforeAll(() => {
    tokens = signTokenPair({
      sub: 'user-001',
      email: 'analyst@terminal.io',
      role: 'analyst' as const,
    });
  });

  it('generates an access token and a refresh token', () => {
    expect(tokens.accessToken).toBeDefined();
    expect(tokens.refreshToken).toBeDefined();
    expect(typeof tokens.accessToken).toBe('string');
    expect(typeof tokens.refreshToken).toBe('string');
    expect(tokens.accessToken.split('.')).toHaveLength(3); // JWT has 3 parts
    expect(tokens.refreshToken.split('.')).toHaveLength(3);
  });

  it('returns a positive expiresIn value', () => {
    expect(tokens.expiresIn).toBeGreaterThan(0);
  });
});

describe('Auth: Access Token Verification', () => {
  it('verifies a valid access token and returns payload', () => {
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

    // Tamper with the payload section (middle part)
    const parts = tokens.accessToken.split('.');
    parts[1] = parts[1] + 'TAMPERED';
    const tampered = parts.join('.');

    expect(() => verifyAccessToken(tampered)).toThrow();
  });
});

describe('Auth: Refresh Token Verification', () => {
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

    // Access token was signed with a different secret than refresh tokens
    expect(() => verifyRefreshToken(tokens.accessToken)).toThrow();
  });
});

describe('Auth: Role-Based Access Control', () => {
  it('creates tokens with correct roles', () => {
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

  it('analyst token has the analyst role in payload', () => {
    const tokens = signTokenPair({
      sub: 'user-analyst',
      email: 'analyst@terminal.io',
      role: 'analyst' as const,
    });

    const payload = verifyAccessToken(tokens.accessToken);
    expect(payload.role).toBe('analyst');
  });

  it('admin token has the admin role in payload', () => {
    const tokens = signTokenPair({
      sub: 'user-admin',
      email: 'admin@terminal.io',
      role: 'admin' as const,
    });

    const payload = verifyAccessToken(tokens.accessToken);
    expect(payload.role).toBe('admin');
  });
});

describe('Auth: Token Expiry', () => {
  it('access token has an expiry timestamp', () => {
    const tokens = signTokenPair({
      sub: 'user-expiry',
      email: 'expiry@terminal.io',
      role: 'viewer' as const,
    });

    const payload = verifyAccessToken(tokens.accessToken);
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('expiresIn matches the delta between exp and iat', () => {
    const tokens = signTokenPair({
      sub: 'user-delta',
      email: 'delta@terminal.io',
      role: 'viewer' as const,
    });

    const payload = verifyAccessToken(tokens.accessToken);
    const expectedDelta = payload.exp - Math.floor(Date.now() / 1000);

    // Allow 2 seconds of clock skew
    expect(Math.abs(tokens.expiresIn - expectedDelta)).toBeLessThanOrEqual(2);
  });
});
