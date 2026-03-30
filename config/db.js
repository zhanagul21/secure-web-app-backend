const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

function formatValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

const sql = {
  query: async (strings, ...values) => {
    try {
      let text = "";

      for (let i = 0; i < strings.length; i++) {
        text += strings[i];
        if (i < values.length) {
          text += formatValue(values[i]);
        }
      }

      const result = await pool.query(text);
      return {
        recordset: result.rows,
        rowsAffected: [result.rowCount],
      };
    } catch (error) {
      console.error("SQL QUERY ERROR:", error);
      throw error;
    }
  },
};

const connectDB = async () => {
  try {
    await pool.query("SELECT NOW()");
    console.log("Connected PostgreSQL");
  } catch (error) {
    console.error("DB CONNECTION ERROR:", error);
    throw error;
  }
};

module.exports = {
  sql,
  pool,
  connectDB,
};