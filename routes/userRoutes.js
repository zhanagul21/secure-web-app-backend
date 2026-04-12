const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/authMiddleware");
const { sql, pool, poolConnect } = require("../config/db");
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");

router.get("/profile", verifyToken, async (req, res) => {
  try {
    await poolConnect;

    const result = await pool
      .request()
      .input("userId", sql.Int, req.user.id)
      .query(`
        SELECT TOP 1 id, full_name, email, role, created_at, twofa_enabled
        FROM users
        WHERE id = @userId
      `);

    const user = result.recordset[0];

    if (!user) {
      return res.status(404).json({ message: "Пайдаланушы табылмады" });
    }

    res.json({ user });
  } catch (error) {
    console.error("PROFILE ERROR:", error);
    res.status(500).json({ message: "Профиль жүктеу қатесі" });
  }
});

router.get("/all-users", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Тек admin ғана кіре алады" });
    }

    await poolConnect;

    const result = await pool.request().query(`
      SELECT id, full_name, email, role, created_at, twofa_enabled
      FROM users
      ORDER BY id DESC
    `);

    res.json({ users: result.recordset });
  } catch (error) {
    console.error("ALL USERS ERROR:", error);
    res.status(500).json({ message: "Сервер қатесі" });
  }
});

router.get("/admin-stats", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Тек admin ғана кіре алады" });
    }

    await poolConnect;

    const usersResult = await pool.request().query(`
      SELECT
        COUNT(*) AS total_users,
        SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admin_users
      FROM users
    `);

    const verifiedResult = await pool
      .request()
      .input("isVerified", sql.Bit, 1)
      .query(`
        SELECT COUNT(*) AS verified_users
        FROM users
        WHERE is_verified = @isVerified
      `);

    const documentsResult = await pool.request().query(`
      SELECT
        COUNT(*) AS total_documents,
        COALESCE(SUM(file_size), 0) AS total_file_size
      FROM documents
    `);

    const logsResult = await pool.request().query(`
      SELECT COUNT(*) AS total_events
      FROM activity_logs
    `);

    const linksResult = await pool.request().query(`
      SELECT COUNT(*) AS active_links
      FROM shared_links
      WHERE expires_at > GETDATE()
    `);

    const latestLogsResult = await pool.request().query(`
      SELECT TOP 5 action_type, action_details, created_at
      FROM activity_logs
      ORDER BY created_at DESC
    `);

    res.json({
      stats: {
        ...(usersResult.recordset[0] || {}),
        ...(verifiedResult.recordset[0] || {}),
        ...(documentsResult.recordset[0] || {}),
        ...(logsResult.recordset[0] || {}),
        ...(linksResult.recordset[0] || {}),
        storage_mode: process.env.DATABASE_URL ? "database" : "filesystem",
      },
      latestLogs: latestLogsResult.recordset,
    });
  } catch (error) {
    console.error("ADMIN STATS ERROR:", error);
    res.status(500).json({ message: "Admin статистикасын жүктеу қатесі" });
  }
});

router.post("/admin-create", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Тек admin ғана орындай алады" });
    }

    const { full_name, email, password, role = "user" } = req.body;

    if (!full_name?.trim() || !email?.trim() || !password?.trim()) {
      return res.status(400).json({
        message: "Аты-жөні, email және пароль міндетті",
      });
    }

    if (password.trim().length < 6) {
      return res.status(400).json({
        message: "Пароль кемінде 6 таңба болуы керек",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const safeRole = role === "admin" ? "admin" : "user";

    await poolConnect;

    const existing = await pool
      .request()
      .input("email", sql.NVarChar(255), normalizedEmail)
      .query(`
        SELECT TOP 1 id
        FROM users
        WHERE email = @email
      `);

    if (existing.recordset[0]) {
      return res.status(400).json({ message: "Бұл email бұрыннан бар" });
    }

    const hashedPassword = await bcrypt.hash(password.trim(), 12);

    const result = await pool
      .request()
      .input("fullName", sql.NVarChar(255), full_name.trim())
      .input("email", sql.NVarChar(255), normalizedEmail)
      .input("passwordHash", sql.NVarChar(500), hashedPassword)
      .input("role", sql.NVarChar(50), safeRole)
      .input("isVerified", sql.Bit, 1)
      .query(`
        INSERT INTO users (
          full_name,
          email,
          password_hash,
          role,
          is_verified,
          created_at
        )
        OUTPUT INSERTED.*
        VALUES (
          @fullName,
          @email,
          @passwordHash,
          @role,
          @isVerified,
          GETDATE()
        )
      `);

    res.json({
      message: "Қолданушы қосылды",
      user: result.recordset[0],
    });
  } catch (error) {
    console.error("ADMIN CREATE USER ERROR:", error);
    res.status(500).json({ message: "Қолданушы қосу қатесі" });
  }
});

router.put("/make-admin/:id", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Тек admin ғана орындай алады" });
    }

    const id = parseInt(req.params.id, 10);

    await poolConnect;
    await pool
      .request()
      .input("id", sql.Int, id)
      .query(`
        UPDATE users
        SET role = 'admin'
        WHERE id = @id
      `);

    res.json({ message: "Қолданушы admin болды" });
  } catch (error) {
    console.error("MAKE ADMIN ERROR:", error);
    res.status(500).json({ message: "Сервер қатесі" });
  }
});

router.delete("/delete/:id", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Тек admin ғана орындай алады" });
    }

    const id = parseInt(req.params.id, 10);

    await poolConnect;
    await pool
      .request()
      .input("id", sql.Int, id)
      .query(`
        DELETE FROM users
        WHERE id = @id
      `);

    res.json({ message: "Қолданушы өшірілді" });
  } catch (error) {
    console.error("DELETE USER ERROR:", error);
    res.status(500).json({ message: "Сервер қатесі" });
  }
});

router.get("/2fa/setup", verifyToken, async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({
      name: `AuthGuardLocker (${req.user.email})`,
      issuer: "AuthGuardLocker",
      length: 20,
    });

    const qr = await QRCode.toDataURL(secret.otpauth_url);

    await poolConnect;
    await pool
      .request()
      .input("secret", sql.NVarChar(255), secret.base32)
      .input("userId", sql.Int, req.user.id)
      .query(`
        UPDATE users
        SET twofa_secret = @secret
        WHERE id = @userId
      `);

    res.json({
      qr,
      secret: secret.base32,
      message: "QR код дайын",
    });
  } catch (error) {
    console.error("2FA SETUP ERROR:", error);
    res.status(500).json({
      message: "QR кодты жүктеу кезінде қате шықты",
    });
  }
});

router.post("/2fa/verify", verifyToken, async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ message: "Код міндетті" });
    }

    await poolConnect;

    const result = await pool
      .request()
      .input("userId", sql.Int, req.user.id)
      .query(`
        SELECT TOP 1 twofa_secret
        FROM users
        WHERE id = @userId
      `);

    const user = result.recordset[0];

    if (!user) {
      return res.status(404).json({ message: "Пайдаланушы табылмады" });
    }

    if (!user.twofa_secret) {
      return res.status(400).json({ message: "Алдымен QR жасап алыңыз" });
    }

    const verified = speakeasy.totp.verify({
      secret: user.twofa_secret,
      encoding: "base32",
      token: token.trim(),
      window: 1,
    });

    if (!verified) {
      return res.status(400).json({ message: "Код қате" });
    }

    await pool
      .request()
      .input("userId", sql.Int, req.user.id)
      .query(`
        UPDATE users
        SET twofa_enabled = 1
        WHERE id = @userId
      `);

    await pool
      .request()
      .input("userId", sql.Int, req.user.id)
      .input("actionType", sql.NVarChar(100), "2FA_ENABLE")
      .input("actionDetails", sql.NVarChar(sql.MAX), "Екі факторлы аутентификация қосылды")
      .query(`
        INSERT INTO activity_logs (user_id, action_type, action_details, created_at)
        VALUES (@userId, @actionType, @actionDetails, GETDATE())
      `);

    res.json({ message: "2FA сәтті қосылды" });
  } catch (error) {
    console.error("2FA VERIFY ERROR:", error);
    res.status(500).json({ message: "2FA растау кезінде қате шықты" });
  }
});

router.post("/2fa/disable", verifyToken, async (req, res) => {
  try {
    await poolConnect;

    await pool
      .request()
      .input("userId", sql.Int, req.user.id)
      .query(`
        UPDATE users
        SET twofa_secret = NULL,
            twofa_enabled = 0
        WHERE id = @userId
      `);

    await pool
      .request()
      .input("userId", sql.Int, req.user.id)
      .input("actionType", sql.NVarChar(100), "2FA_DISABLE")
      .input("actionDetails", sql.NVarChar(sql.MAX), "Екі факторлы аутентификация өшірілді")
      .query(`
        INSERT INTO activity_logs (user_id, action_type, action_details, created_at)
        VALUES (@userId, @actionType, @actionDetails, GETDATE())
      `);

    res.json({ message: "2FA өшірілді" });
  } catch (error) {
    console.error("2FA DISABLE ERROR:", error);
    res.status(500).json({ message: "2FA өшіру кезінде қате шықты" });
  }
});

router.post("/2fa/reset-login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email мен пароль міндетті" });
    }

    await poolConnect;

    const result = await pool
      .request()
      .input("email", sql.NVarChar(255), email.trim().toLowerCase())
      .query(`
        SELECT TOP 1 *
        FROM users
        WHERE email = @email
      `);

    const user = result.recordset[0];

    if (!user) {
      return res.status(404).json({ message: "Пайдаланушы табылмады" });
    }

    const storedHash = user.password_hash || user.password;

    if (!storedHash) {
      return res.status(500).json({
        message: "Пайдаланушы паролі базаға дұрыс сақталмаған",
      });
    }

    const isMatch = await bcrypt.compare(password, storedHash);

    if (!isMatch) {
      return res.status(400).json({ message: "Қате пароль" });
    }

    const secret = speakeasy.generateSecret({
      name: `AuthGuardLocker (${user.email})`,
      issuer: "AuthGuardLocker",
      length: 20,
    });

    const qr = await QRCode.toDataURL(secret.otpauth_url);

    await pool
      .request()
      .input("secret", sql.NVarChar(255), secret.base32)
      .input("userId", sql.Int, user.id)
      .query(`
        UPDATE users
        SET twofa_secret = @secret,
            twofa_enabled = 0
        WHERE id = @userId
      `);

    res.json({
      qr,
      secret: secret.base32,
      message: "Жаңа QR код дайын",
    });
  } catch (error) {
    console.error("2FA RESET LOGIN ERROR:", error);
    res.status(500).json({ message: "QR қайта алу кезінде қате шықты" });
  }
});

module.exports = router;
