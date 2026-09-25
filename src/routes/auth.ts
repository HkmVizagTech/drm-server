import { Router } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../db/pool';
import { generateToken, authenticate } from '../middleware/auth';

const router = Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = generateToken({ userId: user.id, role: user.role });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

router.post('/register', async (req, res) => {
  const { name, email, password, role } = req.body;
  const hash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4) RETURNING id, name, email, role`,
    [name, email, hash, role || 'admin']
  );
  const user = result.rows[0];
  const token = generateToken({ userId: user.id, role: user.role });
  res.status(201).json({ token, user });
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
  const result = await pool.query('SELECT id, name, email, role FROM users WHERE id = $1', [req.user!.userId]);
  if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(result.rows[0]);
});

export default router;
