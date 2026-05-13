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
  BigInt: "bigint",
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

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS biometric_credentials (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        credential_id VARCHAR(500) UNIQUE NOT NULL,
        public_key TEXT NOT NULL,
        sign_count BIGINT DEFAULT 0,
        device_name VARCHAR(255),
        aaguid VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_used_at TIMESTAMPTZ DEFAULT NOW()
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
      IF OBJECT_ID('users', 'U') IS NULL
      BEGIN
        CREATE TABLE users (
          id INT IDENTITY(1,1) PRIMARY KEY,
          full_name NVARCHAR(255) NULL,
          avatar_url NVARCHAR(MAX) NULL,
          email NVARCHAR(255) NOT NULL UNIQUE,
          password_hash NVARCHAR(500) NULL,
          password NVARCHAR(500) NULL,
          role NVARCHAR(50) NOT NULL DEFAULT 'user',
          is_verified BIT NOT NULL DEFAULT 0,
          verification_code NVARCHAR(10) NULL,
          code_expires_at DATETIME NULL,
          reset_code NVARCHAR(10) NULL,
          reset_code_expires DATETIME NULL,
          twofa_secret NVARCHAR(255) NULL,
          twofa_enabled BIT NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT GETDATE()
        );
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('users', 'avatar_url') IS NULL
      BEGIN
        ALTER TABLE users ADD avatar_url NVARCHAR(MAX) NULL;
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('users', 'password_hash') IS NULL
      BEGIN
        ALTER TABLE users ADD password_hash NVARCHAR(500) NULL;
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('users', 'password') IS NULL
      BEGIN
        ALTER TABLE users ADD password NVARCHAR(500) NULL;
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('users', 'is_verified') IS NULL
      BEGIN
        ALTER TABLE users ADD is_verified BIT NOT NULL CONSTRAINT DF_users_is_verified DEFAULT 0;
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('users', 'verification_code') IS NULL
      BEGIN
        ALTER TABLE users ADD verification_code NVARCHAR(10) NULL;
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('users', 'code_expires_at') IS NULL
      BEGIN
        ALTER TABLE users ADD code_expires_at DATETIME NULL;
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('users', 'reset_code') IS NULL
      BEGIN
        ALTER TABLE users ADD reset_code NVARCHAR(10) NULL;
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('users', 'reset_code_expires') IS NULL
      BEGIN
        ALTER TABLE users ADD reset_code_expires DATETIME NULL;
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('users', 'twofa_secret') IS NULL
      BEGIN
        ALTER TABLE users ADD twofa_secret NVARCHAR(255) NULL;
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('users', 'twofa_enabled') IS NULL
      BEGIN
        ALTER TABLE users ADD twofa_enabled BIT NOT NULL CONSTRAINT DF_users_twofa_enabled DEFAULT 0;
      END
    `);

    await pool.request().query(`
      IF OBJECT_ID('documents', 'U') IS NULL
      BEGIN
        CREATE TABLE documents (
          id INT IDENTITY(1,1) PRIMARY KEY,
          user_id INT NULL,
          title NVARCHAR(255) NOT NULL,
          category NVARCHAR(255) NOT NULL,
          description NVARCHAR(MAX) NULL,
          filename NVARCHAR(500) NOT NULL,
          original_name NVARCHAR(500) NULL,
          mime_type NVARCHAR(255) NULL,
          file_size INT NULL,
          file_data VARBINARY(MAX) NULL,
          created_at DATETIME NOT NULL DEFAULT GETDATE()
        );
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('documents', 'category') IS NULL
      BEGIN
        ALTER TABLE documents ADD category NVARCHAR(255) NULL;
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('documents', 'filename') IS NULL
      BEGIN
        ALTER TABLE documents ADD filename NVARCHAR(500) NULL;
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('documents', 'original_name') IS NULL
      BEGIN
        ALTER TABLE documents ADD original_name NVARCHAR(500) NULL;
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('documents', 'mime_type') IS NULL
      BEGIN
        ALTER TABLE documents ADD mime_type NVARCHAR(255) NULL;
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('documents', 'file_size') IS NULL
      BEGIN
        ALTER TABLE documents ADD file_size INT NULL;
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('documents', 'file_data') IS NULL
      BEGIN
        ALTER TABLE documents ADD file_data VARBINARY(MAX) NULL;
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('documents', 'secret_content') IS NOT NULL
      BEGIN
        ALTER TABLE documents DROP COLUMN secret_content;
      END
    `);

    await pool.request().query(`
      IF OBJECT_ID('shared_links', 'U') IS NULL
      BEGIN
        CREATE TABLE shared_links (
          id INT IDENTITY(1,1) PRIMARY KEY,
          document_id INT NOT NULL,
          token NVARCHAR(255) NOT NULL UNIQUE,
          expires_at DATETIME NOT NULL,
          created_by INT NULL,
          created_at DATETIME NOT NULL DEFAULT GETDATE()
        );
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('shared_links', 'created_by') IS NULL
      BEGIN
        ALTER TABLE shared_links ADD created_by INT NULL;
      END
    `);

    await pool.request().query(`
      IF COL_LENGTH('shared_links', 'created_at') IS NULL
      BEGIN
        ALTER TABLE shared_links ADD created_at DATETIME NOT NULL CONSTRAINT DF_shared_links_created_at DEFAULT GETDATE();
      END
    `);

    await pool.request().query(`
      IF OBJECT_ID('activity_logs', 'U') IS NULL
      BEGIN
        CREATE TABLE activity_logs (
          id INT IDENTITY(1,1) PRIMARY KEY,
          user_id INT NULL,
          action_type NVARCHAR(100) NULL,
          action_details NVARCHAR(MAX) NULL,
          created_at DATETIME NOT NULL DEFAULT GETDATE()
        );
      END
    `);

    await pool.request().query(`
      IF OBJECT_ID('biometric_credentials', 'U') IS NULL
      BEGIN
        CREATE TABLE biometric_credentials (
          id INT IDENTITY(1,1) PRIMARY KEY,
          user_id INT NOT NULL,
          credential_id NVARCHAR(500) NOT NULL UNIQUE,
          public_key NVARCHAR(MAX) NOT NULL,
          sign_count BIGINT DEFAULT 0,
          device_name NVARCHAR(255) NULL,
          aaguid NVARCHAR(255) NULL,
          created_at DATETIME DEFAULT GETDATE(),
          last_used_at DATETIME DEFAULT GETDATE(),
          CONSTRAINT FK_biometric_credentials_users
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
      END
    `);

    await pool.request().query(`
      IF NOT EXISTS (
        SELECT 1
        FROM sys.foreign_keys
        WHERE name = 'FK_documents_users'
      ) AND COL_LENGTH('documents', 'user_id') IS NOT NULL
      BEGIN
        ALTER TABLE documents
        ADD CONSTRAINT FK_documents_users
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
      END
    `);

    await pool.request().query(`
      IF NOT EXISTS (
        SELECT 1
        FROM sys.foreign_keys
        WHERE name = 'FK_shared_links_documents'
      ) AND COL_LENGTH('shared_links', 'document_id') IS NOT NULL
      BEGIN
        ALTER TABLE shared_links
        ADD CONSTRAINT FK_shared_links_documents
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE;
      END
    `);

    await pool.request().query(`
      IF NOT EXISTS (
        SELECT 1
        FROM sys.foreign_keys
        WHERE name = 'FK_shared_links_users'
      ) AND COL_LENGTH('shared_links', 'created_by') IS NOT NULL
      BEGIN
        ALTER TABLE shared_links
        ADD CONSTRAINT FK_shared_links_users
        FOREIGN KEY (created_by) REFERENCES users(id);
      END
    `);

    await pool.request().query(`
      IF NOT EXISTS (
        SELECT 1
        FROM sys.foreign_keys
        WHERE name = 'FK_activity_logs_users'
      ) AND COL_LENGTH('activity_logs', 'user_id') IS NOT NULL
      BEGIN
        ALTER TABLE activity_logs
        ADD CONSTRAINT FK_activity_logs_users
        FOREIGN KEY (user_id) REFERENCES users(id);
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
