import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthPayload, UserRole } from '../types';

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/**
 * The signing secret, and why this refuses to start without one.
 *
 * It used to fall back to the literal string 'dev-secret-change-in-production'.
 * That string is in this repository, so a deploy that lost JWT_SECRET - a
 * renamed variable, a fresh environment, a typo - would come up looking
 * perfectly healthy while anybody who had read the source could mint
 * themselves an admin token. Nothing would have logged, and nothing would have
 * looked wrong.
 *
 * Outside development the process now refuses to start. A DRM that is down is
 * a bad morning; a DRM anyone can sign into as an admin is the donor database.
 */
const JWT_SECRET = (() => {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  if (process.env.NODE_ENV === 'production') {
    console.error(
      'FATAL: JWT_SECRET is missing or too short (16+ characters). ' +
        'Refusing to start rather than signing tokens with a secret that is public in the source.'
    );
    process.exit(1);
  }
  console.warn('[auth] JWT_SECRET is not set - using a development secret. Never do this in production.');
  return 'dev-secret-change-in-production';
})();

export function generateToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthPayload;
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function authorize(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/**
 * Let a role read a router but not change anything through it.
 *
 * Mounted ahead of the routes rather than sprinkled through them: a guard that
 * has to be remembered on every new handler is a guard that will be forgotten
 * on the one that matters. GET and HEAD pass; everything else is refused.
 *
 * Export routes are the exception that has to be named. A CSV download is a GET
 * and cannot be told apart from reading a page by method alone, so if the temple
 * ever decides callers should not be able to take the donor list away, that is a
 * separate check on those handlers — not something this one can do.
 */
/**
 * Shut a router to particular roles entirely.
 *
 * The inverse of authorize(): that one names who may in, this one names who may
 * not. Written this way round for the modules a caller has no business in at
 * all — prasadam, seva, events, reports — because the list of roles that SHOULD
 * reach them will grow as the temple adds staff, and a deny-list does not have
 * to be updated every time it does.
 */
export function denyRole(...roles: UserRole[]) {
  // authenticate first, because each router calls it internally and so it has
  // NOT run by the time a guard mounted ahead of that router is reached. A
  // guard that tests req.user without this passes everybody through: it reads
  // undefined, finds no matching role, and calls next(). Running it here makes
  // the check real, and the second call inside the router is a cheap re-verify
  // of a token already in hand.
  return [
    authenticate,
    (req: Request, res: Response, next: NextFunction) => {
      if (req.user && roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Your account does not have access to that part of DRM.' });
      }
      next();
    },
  ];
}

export function readOnlyFor(...roles: UserRole[]) {
  // authenticate first — see the note in denyRole. Without it this guard reads
  // an empty req.user and waves every write through.
  return [
    authenticate,
    (req: Request, res: Response, next: NextFunction) => {
      if (req.user && roles.includes(req.user.role) && req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(403).json({
          error: 'Your account can look at donor records but not change them.',
        });
      }
      next();
    },
  ];
}
