const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/authMiddleware");
const { connectDB } = require("../config/db");
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");

// Профиль
router.get("/profile", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const db = await connectDB();

    const result = await db.query(
      `
      SELECT id, full_name, email, role, created_at, twofa_enabled
      FROM users
      WHERE id = $1
      `,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Пайдаланушы табылмады" });
    }

    res.json({
      user: result.rows[0],
    });
  } catch (error) {
    console.error("PROFILE ERROR:", error);
    res.status(500).json({ message: "Сервер қатесі" });
  }
});

// Барлық қолданушылар
router.get("/all-users", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Тек admin ғана кіре алады" });
    }

    const db = await connectDB();

    const result = await db.query(`
      SELECT id, full_name, email, role, created_at, twofa_enabled
      FROM users
      ORDER BY id DESC
    `);

    res.json({
      users: result.rows,
    });
  } catch (error) {
    console.error("ALL USERS ERROR:", error);
    res.status(500).json({ message: "Сервер қатесі" });
  }
});

// Admin қылу
router.put("/make-admin/:id", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Тек admin ғана орындай алады" });
    }

    const id = parseInt(req.params.id, 10);
    const db = await connectDB();

    await db.query(
      `
      UPDATE users
      SET role = 'admin'
      WHERE id = $1
      `,
      [id]
    );

    res.json({ message: "Қолданушы admin болды" });
  } catch (error) {
    console.error("MAKE ADMIN ERROR:", error);
    res.status(500).json({ message: "Сервер қатесі" });
  }
});

// Қолданушы өшіру
router.delete("/delete/:id", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Тек admin ғана орындай алады" });
    }

    const id = parseInt(req.params.id, 10);
    const db = await connectDB();

    await db.query(
      `
      DELETE FROM users
      WHERE id = $1
      `,
      [id]
    );

    res.json({ message: "Қолданушы өшірілді" });
  } catch (error) {
    console.error("DELETE USER ERROR:", error);
    res.status(500).json({ message: "Сервер қатесі" });
  }
});

// 2FA setup
router.get("/2fa/setup", verifyToken, async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({
      name: `AuthGuardLocker (${req.user.email})`,
      issuer: "AuthGuardLocker",
      length: 20,
    });

    const qr = await QRCode.toDataURL(secret.otpauth_url);
    const db = await connectDB();

    await db.query(
      `
      UPDATE users
      SET twofa_secret = $1
      WHERE id = $2
      `,
      [secret.base32, req.user.id]
    );

    res.json({
      qr: qr,
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

// 2FA verify
router.post("/2fa/verify", verifyToken, async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ message: "Код міндетті" });
    }

    const db = await connectDB();

    const result = await db.query(
      `
      SELECT twofa_secret
      FROM users
      WHERE id = $1
      `,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Пайдаланушы табылмады" });
    }

    const secret = result.rows[0].twofa_secret;

    if (!secret) {
      return res.status(400).json({ message: "Алдымен QR жасап алыңыз" });
    }

    const verified = speakeasy.totp.verify({
      secret: secret,
      encoding: "base32",
      token: token,
      window: 1,
    });

    if (!verified) {
      return res.status(400).json({ message: "Код қате" });
    }

    await db.query(
      `
      UPDATE users
      SET twofa_enabled = $1
      WHERE id = $2
      `,
      [true, req.user.id]
    );

    await db.query(
      `
      INSERT INTO activity_logs (user_id, action_type, action_details)
      VALUES ($1, $2, $3)
      `,
      [req.user.id, "2FA_ENABLE", "Екі факторлы аутентификация қосылды"]
    );

    res.json({ message: "2FA сәтті қосылды" });
  } catch (error) {
    console.error("2FA VERIFY ERROR:", error);
    res.status(500).json({ message: "2FA растау кезінде қате шықты" });
  }
});

module.exports = router;