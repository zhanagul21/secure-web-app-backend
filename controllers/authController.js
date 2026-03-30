const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const speakeasy = require("speakeasy");
const { sql } = require("../config/db");
const { sendVerificationEmail } = require("../utils/sendEmail");

// SEND CODE
const sendCode = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email міндетті" });
    }

    const existing = await sql.query`
      SELECT * FROM users WHERE email = ${email}
    `;

    if (existing.recordset.length > 0 && existing.recordset[0].is_verified) {
      return res.status(400).json({ message: "Бұл email бұрын тіркелген" });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    if (existing.recordset.length > 0) {
      await sql.query`
        UPDATE users
        SET verification_code = ${code},
            code_expires_at = ${expiresAt}
        WHERE email = ${email}
      `;
    } else {
      await sql.query`
        INSERT INTO users (full_name, email, password_hash, role, is_verified, verification_code, code_expires_at)
        VALUES (${""}, ${email}, ${""}, ${"user"}, ${false}, ${code}, ${expiresAt})
      `;
    }

    await sendVerificationEmail(email, code);

    res.json({ message: "Код жіберілді" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Қате" });
  }
};

// VERIFY CODE
const verifyCode = async (req, res) => {
  try {
    const { email, code } = req.body;

    const result = await sql.query`
      SELECT * FROM users WHERE email = ${email}
    `;

    const user = result.recordset[0];

    if (!user) return res.status(404).json({ message: "Табылмады" });

    if (user.verification_code !== code) {
      return res.status(400).json({ message: "Код қате" });
    }

    if (user.code_expires_at && new Date(user.code_expires_at) < new Date()) {
      return res.status(400).json({ message: "Код уақыты өтті" });
    }

    res.json({ message: "OK" });
  } catch (e) {
    res.status(500).json({ message: "Қате" });
  }
};

// COMPLETE REGISTER
const completeRegister = async (req, res) => {
  try {
    const { full_name, email, password } = req.body;

    const result = await sql.query`
      SELECT * FROM users WHERE email = ${email}
    `;

    const user = result.recordset[0];

    if (!user) return res.status(404).json({ message: "Табылмады" });

    const hash = await bcrypt.hash(password, 10);

    await sql.query`
      UPDATE users
      SET full_name = ${full_name},
          password_hash = ${hash},
          is_verified = ${true},
          verification_code = ${null},
          code_expires_at = ${null}
      WHERE email = ${email}
    `;

    res.json({ message: "Тіркелді" });
  } catch {
    res.status(500).json({ message: "Қате" });
  }
};

// LOGIN
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await sql.query`
      SELECT * FROM users WHERE email = ${email}
    `;

    const user = result.recordset[0];

    if (!user) {
      return res.status(400).json({ message: "Қате email немесе пароль" });
    }

    if (!user.is_verified) {
      return res.status(403).json({ message: "Аккаунт расталмаған" });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(400).json({ message: "Қате email немесе пароль" });
    }

    if (user.twofa_enabled) {
      return res.json({
        requires2fa: true,
        email: user.email,
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// 2FA LOGIN
const verifyLogin2FA = async (req, res) => {
  try {
    const { email, token } = req.body;

    const result = await sql.query`
      SELECT * FROM users WHERE email = ${email}
    `;

    const user = result.recordset[0];

    const verified = speakeasy.totp.verify({
      secret: user.twofa_secret,
      encoding: "base32",
      token,
      window: 1,
    });

    if (!verified) {
      return res.status(400).json({ message: "Қате код" });
    }

    const jwtToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({ token: jwtToken });
  } catch {
    res.status(500).json({ message: "Қате" });
  }
};

module.exports = {
  sendCode,
  verifyCode,
  completeRegister,
  login,
  verifyLogin2FA,
};