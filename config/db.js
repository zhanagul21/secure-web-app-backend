const mssql = require("mssql");
const { Pool: PgPool } = require("pg");

const usePostgres =
  Boolean(process.env.DATABASE_URL) && process.env.DB_DRIVER !== "mssql";

const parseBoolean = (value, fallback) => {
  if (value === undefined) {
    return fallback;
  }

  return value === "true";
};

const pgSql = {
  Int: "int",
  Bit: "bit",
  DateTime: "datetime",
  MAX: "max",
  NVarChar: () => "nvarchar",
};

const translateSqlServerToPostgres = (queryText, inputValues) => {
  let text = queryText.trim();
  const needsLimitOne = /SELECT\s+TOP\s+1\s+/i.test(text);
  const returnsInserted = /OUTPUT\s+INSERTED\.\*/i.test(text);

  text = text
    .replace(/SELECT\s+TOP\s+1\s+/gi, "SELECT ")
    .replace(/OUTPUT\s+INSERTED\.\*/gi, "")
    .replace(/GETDATE\(\)/gi, "NOW()");

  const names = [];
  text = text.replace(/@([A-Za-z][A-Za-z0-9_]*)/g, (_, name) => {
    let index = names.indexOf(name);

    if (index === -1) {
      names.push(name);
      index = names.length - 1;
    }

    return `$${index + 1}`;
  });

  text = text.replace(/;+\s*$/g, "");

  if (returnsInserted && !/\bRETURNING\b/i.test(text)) {
    text += " RETURNING *";
  }

  if (needsLimitOne && !/\bLIMIT\b/i.test(text)) {
    text += " LIMIT 1";
  }

  return {
    text,
    values: names.map((name) => inputValues[name]),
  };
};

const createPostgresAdapter = () => {
  const pgPool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });

  class PgRequest {
    constructor() {
      this.inputValues = {};
    }

    input(name, type, value) {
      this.inputValues[name] = type === pgSql.Bit ? Boolean(value) : value;
      return this;
    }

    async query(queryText) {
      const query = translateSqlServerToPostgres(queryText, this.inputValues);
      const result = await pgPool.query(query.text, query.values);

      return {
        recordset: result.rows,
        rowsAffected: [result.rowCount],
      };
    }
  }

  const ensureSchema = async () => {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(255),
        avatar_url TEXT,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(500),
        password VARCHAR(500),
        role VARCHAR(50) DEFAULT 'user',
        is_verified BOOLEAN DEFAULT FALSE,
        verification_code VARCHAR(10),
        code_expires_at TIMESTAMPTZ,
        reset_code VARCHAR(10),
        reset_code_expires TIMESTAMPTZ,
        twofa_secret VARCHAR(255),
        twofa_enabled BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pgPool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS avatar_url TEXT
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        title VARCHAR(255) NOT NULL,
        category VARCHAR(255) NOT NULL,
        description TEXT,
        filename VARCHAR(500) NOT NULL,
        original_name VARCHAR(500),
        mime_type VARCHAR(255),
        file_size INTEGER,
        file_data BYTEA,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pgPool.query(`
      ALTER TABLE documents
      ADD COLUMN IF NOT EXISTS file_data BYTEA
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS shared_links (
        id SERIAL PRIMARY KEY,
        document_id INTEGER NOT NULL,
        token VARCHAR(255) UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_by INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        action_type VARCHAR(100),
        action_details TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  };

  const poolConnect = (async () => {
    await pgPool.query("SELECT 1");
    await ensureSchema();
    console.log("PostgreSQL connected");
  })();

  pgPool.on("error", (err) => {
    console.error("PostgreSQL pool error:", err);
  });

  return {
    sql: pgSql,
    pool: {
      request: () => new PgRequest(),
      on: (...args) => pgPool.on(...args),
    },
    poolConnect,
    connectDB: async () => {
      await poolConnect;
    },
  };
};

const createSqlServerAdapter = () => {
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

  const pool = new mssql.ConnectionPool(config);
  const poolConnect = pool.connect();

  const ensureSqlServerSchema = async () => {
    await pool.request().query(`
      IF COL_LENGTH('users', 'avatar_url') IS NULL
      BEGIN
        ALTER TABLE users ADD avatar_url NVARCHAR(MAX) NULL;
      END
    `);
  };

  pool.on("error", (err) => {
    console.error("SQL Server pool error:", err);
  });

  return {
    sql: mssql,
    pool,
    poolConnect,
    connectDB: async () => {
      await poolConnect;
      await ensureSqlServerSchema();
      console.log("SQL Server connected");
    },
  };
};

module.exports = {
  ...(usePostgres ? createPostgresAdapter() : createSqlServerAdapter()),
  dbDriver: usePostgres ? "postgres" : "mssql",
};
