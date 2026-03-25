const { Pool } = require("pg");

let pool;

const connectDB = async () => {
  try {
    if (pool) return pool;

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false,
      },
    });

    await pool.connect();
    console.log("PostgreSQL connected");
    return pool;
  } catch (error) {
    console.error("DB CONNECTION ERROR:", error);
    throw error;
  }
};

module.exports = {
  connectDB,
};