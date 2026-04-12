const sql = require("mssql");

const parseBoolean = (value, fallback) => {
  if (value === undefined) {
    return fallback;
  }

  return value === "true";
};

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  port: parseInt(process.env.DB_PORT || "1433", 10),
  options: {
    encrypt: parseBoolean(process.env.DB_ENCRYPT, false),
    trustServerCertificate: parseBoolean(
      process.env.DB_TRUST_SERVER_CERTIFICATE,
      true
    ),
  },
};

const pool = new sql.ConnectionPool(config);
const poolConnect = pool.connect();

pool.on("error", (err) => {
  console.error("SQL Server pool error:", err);
});

const connectDB = async () => {
  try {
    await poolConnect;
    console.log("SQL Server connected");
  } catch (error) {
    console.error("SQL Server connection error:", error);
    throw error;
  }
};

module.exports = {
  sql,
  pool,
  poolConnect,
  connectDB,
};
