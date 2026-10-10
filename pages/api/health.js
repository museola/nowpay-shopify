import pg from 'pg';
const { Pool } = pg;
let pool;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false });
  }

  if (!process.env.DATABASE_URL) {
    console.error('Health check: DATABASE_URL is missing');
    return res.status(503).json({
      ok: false,
      message: 'Database configuration missing',
    });
  }

  try {
    if (!pool) {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 1,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10000,
        query_timeout: 5000,
      });
    }

    await pool.query('SELECT 1');

    return res.status(200).json({
      ok: true,
      message: 'Database connected',
    });
  } catch (err) {
    console.error('Database health check failed:', err.message);

    return res.status(503).json({
      ok: false,
      message: 'Database connection failed',
    });
  }
}
