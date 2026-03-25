const sql = require("mssql");

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  port: parseInt(process.env.DB_PORT || "1433", 10),
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

let pool;

const connectDB = async () => {
  try {
    if (pool) {
      return pool;
    }

    pool = await sql.connect(dbConfig);
    console.log("MSSQL connected");
    return pool;
  } catch (error) {
    console.error("DB CONNECTION ERROR:", error);
    throw error;
  }
};

module.exports = {
  sql,
  connectDB,
};