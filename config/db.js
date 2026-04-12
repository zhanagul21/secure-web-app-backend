const sql = require("mssql");

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  port: parseInt(process.env.DB_PORT || "1433", 10),
  options: {
    encrypt: false,
    trustServerCertificate: true,
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