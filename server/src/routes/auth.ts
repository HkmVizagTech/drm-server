// Signing in, and who is allowed to exist.
//
// WHAT WAS WRONG HERE
// POST /register used to be open to the world and defaulted new accounts to
// 'admin'. On a laptop that is a convenience; on drm.harekrishnavizag.org it
// means anyone who guesses the URL can hand themselves the donor database. It
// is now an admin-only route, with one deliberate exception below.
//
// THE BOOTSTRAP EXCEPTION
// A brand new deployment has no users, so there is nobody who can sign in to
// create the first one. When the users table is empty — and only then —
// /register is open and the account it makes is an admin. The moment that row
// exists the door shuts, because the check is "is the table empty", not a flag
// somebody has to remember to turn off.

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../db/pool';
import { generateToken, authenticate, authorize } from '../middleware/auth';
import type { UserRole } from '../types';

const router = Router();

const ROLES: UserRole[] = ['admin', 'accountant', 'volunteer_coordinator', 'caller'];

// Eight characters is not a strong password, but it is a floor, and a floor
// that staff will actually clear beats a rule that gets worked around with
// "Temple@1" on every account.
const MIN_PASSWORD = 8;

function validate(body: Record<string, unknown>): string | null {
  const name = String(body.name ?? '').trim();
  const email = String(body.email ?? '').trim();
  const password = String(body.password ?? '');
  if (!name) return 'A name is needed';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'That does not look like an email address';
  if (password.length < MIN_PASSWORD) return `A password needs at least ${MIN_PASSWORD} characters`;
  if (body.role !== undefined && !ROLES.includes(body.role as UserRole)) return 'Unknown role';
  return null;
}

async function userCount(): Promise<number> {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM users`);
  return r.rows[0].n;
}

/* ------------------------------------------------------------------- login */

router.post('/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are needed' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE lower(email) = $1', [email]);
    const user = result.rows[0];

    // Hash even when there is no such user, so a wrong email and a wrong
    // password take the same time. Otherwise the response time alone tells
    // somebody which email addresses have accounts.
    const hash = user?.password_hash ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const valid = await bcrypt.compare(password, hash);

    if (!user || !valid) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.active === false) {
      return res.status(403).json({ error: 'That account has been switched off. Ask an administrator.' });
    }

    await pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

    const token = generateToken({ userId: user.id, role: user.role });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    console.error('auth.login error:', err);
    res.status(500).json({ error: 'Could not sign you in' });
  }
});

/* ---------------------------------------------------------------- register */

/**
 * POST /register - create an account.
 *
 * Admins only, except on an empty database (see the note at the top). The two
 * paths are one handler on purpose: a separate "bootstrap" route would be a
 * second door to keep locked, and doors like that get left open.
 */
router.post('/register', async (req, res) => {
  const problem = validate(req.body ?? {});
  if (problem) return res.status(400).json({ error: problem });

  try {
    const first = (await userCount()) === 0;

    if (!first) {
      // Not the first account, so this needs a signed-in admin. Done by hand
      // rather than with router-level middleware because the bootstrap case
      // has to get past it.
      await new Promise<void>((resolve, reject) =>
        authenticate(req, res, (e?: unknown) => (e ? reject(e) : resolve()))
      ).catch(() => undefined);
      if (!req.user) return res.status(401).json({ error: 'Sign in first' });
      if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only an administrator can create accounts' });
      }
    }

    const name = String(req.body.name).trim();
    const email = String(req.body.email).trim().toLowerCase();
    // The very first account is an admin whatever was asked for - there would
    // be nobody to promote it otherwise.
    const role: UserRole = first ? 'admin' : ((req.body.role as UserRole) ?? 'caller');
    const hash = await bcrypt.hash(String(req.body.password), 10);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, email, role, created_at`,
      [name, email, hash, role, req.user?.userId ?? null]
    );
    const user = result.rows[0];

    // Only the bootstrap signs the new account in. An admin adding a caller
    // stays signed in as themselves; handing back a token for somebody else
    // would log the admin out of their own session.
    if (first) {
      return res.status(201).json({ token: generateToken({ userId: user.id, role: user.role }), user });
    }
    res.status(201).json({ user });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Somebody already has that email address' });
    }
    console.error('auth.register error:', err);
    res.status(500).json({ error: 'Could not create that account' });
  }
});

/** Whether this deployment still has no users - the login screen asks. */
router.get('/needs-setup', async (_req, res) => {
  try {
    res.json({ needs_setup: (await userCount()) === 0 });
  } catch {
    res.json({ needs_setup: false });
  }
});

router.get('/me', authenticate, async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, email, role, active FROM users WHERE id = $1',
    [req.user!.userId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(result.rows[0]);
});

/** Changing your own password. Needs the current one, even for an admin. */
router.post('/change-password', authenticate, async (req, res) => {
  const current = String(req.body?.current_password ?? '');
  const next = String(req.body?.new_password ?? '');
  if (next.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `A password needs at least ${MIN_PASSWORD} characters` });
  }
  try {
    const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user!.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    if (!(await bcrypt.compare(current, r.rows[0].password_hash))) {
      return res.status(403).json({ error: 'That is not your current password' });
    }
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      await bcrypt.hash(next, 10),
      req.user!.userId,
    ]);
    res.json({ changed: true });
  } catch (err) {
    console.error('auth.changePassword error:', err);
    res.status(500).json({ error: 'Could not change your password' });
  }
});

/* ------------------------------------------------------------ the team list */

router.get('/users', authenticate, authorize('admin'), async (_req, res) => {
  try {
    const rows = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.active, u.created_at, u.last_login_at,
              COALESCE(l.assigned, 0)  AS assigned_leads,
              COALESCE(l.open, 0)      AS open_leads,
              COALESCE(c.calls_7d, 0)  AS calls_7d
         FROM users u
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS assigned,
                  COUNT(*) FILTER (WHERE COALESCE(s.is_open, TRUE) AND NOT le.do_not_call)::int AS open
             FROM leads le
             LEFT JOIN crm_statuses s ON le.status = s.slug
            WHERE le.assigned_to = u.id
         ) l ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS calls_7d FROM lead_activities a
            WHERE a.user_id = u.id AND a.kind = 'call' AND a.created_at > NOW() - INTERVAL '7 days'
         ) c ON TRUE
        ORDER BY u.active DESC, u.name`
    );
    res.json({ users: rows.rows });
  } catch (err) {
    console.error('auth.listUsers error:', err);
    res.status(500).json({ error: 'Could not load the team' });
  }
});

/** Rename, change role, switch on or off. Not the password - that is below. */
router.put('/users/:id', authenticate, authorize('admin'), async (req, res) => {
  const b = req.body ?? {};
  const role = b.role === undefined ? null : String(b.role);
  if (role && !ROLES.includes(role as UserRole)) return res.status(400).json({ error: 'Unknown role' });

  try {
    // An admin must not be able to lock the last admin out, by demotion or by
    // switching them off. Checked before the write rather than after, because
    // "there are no admins left" is not a state to recover from through this
    // API - it needs somebody with database access.
    const losingAdmin =
      (role && role !== 'admin') || b.active === false;
    if (losingAdmin) {
      const target = await pool.query('SELECT role, active FROM users WHERE id = $1', [req.params.id]);
      if (target.rows[0]?.role === 'admin' && target.rows[0]?.active !== false) {
        const others = await pool.query(
          `SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND active AND id <> $1`,
          [req.params.id]
        );
        if (others.rows[0].n === 0) {
          return res.status(409).json({
            error: 'That is the only administrator left. Make somebody else an administrator first.',
          });
        }
      }
    }

    const result = await pool.query(
      `UPDATE users SET
         name   = COALESCE($1, name),
         role   = COALESCE($2, role),
         active = COALESCE($3::boolean, active)
       WHERE id = $4
       RETURNING id, name, email, role, active`,
      [
        b.name === undefined ? null : String(b.name).trim().slice(0, 255) || null,
        role,
        typeof b.active === 'boolean' ? b.active : null,
        req.params.id,
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'No such account' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('auth.updateUser error:', err);
    res.status(500).json({ error: 'Could not save that' });
  }
});

/**
 * An admin setting somebody else's password.
 *
 * There is no email on this deployment, so a "send a reset link" flow would
 * have nowhere to send it. The admin sets a password and tells the person —
 * which is how a temple office works anyway.
 */
router.post('/users/:id/password', authenticate, authorize('admin'), async (req, res) => {
  const next = String(req.body?.new_password ?? '');
  if (next.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `A password needs at least ${MIN_PASSWORD} characters` });
  }
  try {
    const r = await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id', [
      await bcrypt.hash(next, 10),
      req.params.id,
    ]);
    if (!r.rows.length) return res.status(404).json({ error: 'No such account' });
    res.json({ changed: true });
  } catch (err) {
    console.error('auth.setPassword error:', err);
    res.status(500).json({ error: 'Could not set that password' });
  }
});

export default router;
