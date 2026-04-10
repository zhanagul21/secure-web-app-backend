const sql = require("mssql");

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 1433,
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
};

const poolPromise = sql.connect(config);

const connectDB = async () => {
  try {
    await poolPromise;
    console.log("MSSQL connected");

    const pool = await poolPromise;

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='users' AND xtype='U')
      CREATE TABLE users (
        id INT IDENTITY(1,1) PRIMARY KEY,
        full_name NVARCHAR(255) NULL,
        email NVARCHAR(255) UNIQUE NOT NULL,
        password_hash NVARCHAR(255) NOT NULL,
        role NVARCHAR(50) DEFAULT 'user',
        is_verified BIT DEFAULT 0,
        twofa_secret NVARCHAR(255) NULL,
        twofa_enabled BIT DEFAULT 0,
        verification_code NVARCHAR(10) NULL,
        code_expires_at DATETIME NULL,
        reset_code NVARCHAR(10) NULL,
        reset_code_expires DATETIME NULL,
        created_at DATETIME DEFAULT GETDATE()
      )
    `);

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='documents' AND xtype='U')
      CREATE TABLE documents (
        id INT IDENTITY(1,1) PRIMARY KEY,
        user_id INT FOREIGN KEY REFERENCES users(id) ON DELETE CASCADE,
        title NVARCHAR(255) NOT NULL,
        category NVARCHAR(100) NULL,
        description NVARCHAR(MAX) NULL,
        secret_content NVARCHAR(255) NULL,
        original_name NVARCHAR(255) NULL,
        mime_type NVARCHAR(100) NULL,
        created_at DATETIME DEFAULT GETDATE()
      )
    `);

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='activity_logs' AND xtype='U')
      CREATE TABLE activity_logs (
        id INT IDENTITY(1,1) PRIMARY KEY,
        user_id INT FOREIGN KEY REFERENCES users(id) ON DELETE CASCADE,
        action_type NVARCHAR(100) NULL,
        action_details NVARCHAR(MAX) NULL,
        created_at DATETIME DEFAULT GETDATE()
      )
    `);

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='shared_links' AND xtype='U')
      CREATE TABLE shared_links (
        id INT IDENTITY(1,1) PRIMARY KEY,
        document_id INT FOREIGN KEY REFERENCES documents(id) ON DELETE CASCADE,
        token NVARCHAR(255) UNIQUE NOT NULL,
        expires_at DATETIME NOT NULL,
        created_by INT FOREIGN KEY REFERENCES users(id) ON DELETE CASCADE,
        created_at DATETIME DEFAULT GETDATE()
      )
    `);

    console.log("Tables ready");
  } catch (error) {
    console.error("DB error:", error);
    throw error;
  }
};

module.exports = { sql, poolPromise, connectDB };