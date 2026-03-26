const { Pool } = require("pg");

let pool;

const connectDB = async () => {
  try {
    if (!pool) {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
          rejectUnauthorized: false,
        },
      });
    }

    await pool.query("SELECT NOW()");
    console.log("PostgreSQL connected");
    return pool;
  } catch (error) {
    console.error("DB CONNECTION ERROR:", error);
    throw error;
  }
};

const ensureSchema = async () => {
  try {
    const db = await connectDB();

    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(255) DEFAULT '',
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT DEFAULT '',
        role VARCHAR(50) DEFAULT 'user',
        is_verified BOOLEAN DEFAULT FALSE,
        verification_code VARCHAR(20),
        code_expires_at TIMESTAMP,
        twofa_enabled BOOLEAN DEFAULT FALSE,
        twofa_secret TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        category VARCHAR(255) NOT NULL,
        description TEXT DEFAULT '',
        secret_content TEXT,
        original_name TEXT,
        mime_type TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action_type VARCHAR(100) NOT NULL,
        action_details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("Database schema ready");
  } catch (error) {
    console.error("SCHEMA ERROR:", error);
    throw error;
  }
};

module.exports = {
  connectDB,
  ensureSchema,
  pool,
};