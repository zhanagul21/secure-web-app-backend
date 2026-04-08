const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const speakeasy = require("speakeasy");
const { sql } = require("../config/db");

// SEND CODE - уақытша fake success
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

    // Email жібермейміз, тек success қайтарамыз
    return res.json({ message: "Код жіберілді" });
  } catch (error) {
    console.error("SEND CODE ERROR:", error);
    return res.status(500).json({ message: "Қате" });
  }
};

// VERIFY CODE - уақытша always success
const verifyCode = async (req, res) => {
  try {
    return res.json({ message: "OK" });
  } catch (e) {
    return res.status(500).json({ message: "Қате" });
  }
};

// COMPLETE REGISTER - бірден verified қылып тіркейді
const completeRegister = async (req, res) => {
  try {
    const { full_name, email, password } = req.body;

    if (!full_name || !email || !password) {
      return res.status(400).json({ message: "Барлық өрістерді толтырыңыз" });
    }

    const result = await sql.query`
      SELECT * FROM users WHERE email = ${email}
    `;

    const user = result.recordset[0];
    const hash = await bcrypt.hash(password, 10);

    if (!user) {
      await sql.query`
        INSERT INTO users (full_name, email, password_hash, role, is_verified)
        VALUES (${full_name}, ${email}, ${hash}, ${"user"}, ${true})
      `;
    } else {
      await sql.query`
        UPDATE users
        SET full_name = ${full_name},
            password_hash = ${hash},
            role = ${"user"},
            is_verified = ${true},
            verification_code = ${null},
            code_expires_at = ${null}
        WHERE email = ${email}
      `;
    }

    return res.json({ message: "Тіркелді" });
  } catch (error) {
    console.error("COMPLETE REGISTER ERROR:", error);
    return res.status(500).json({ message: "Қате" });
  }
};

// LOGIN - is_verified тексермейміз
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

    const isMatch = await bcrypt.compare(password, user.password_hash || "");

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

    return res.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    return res.status(500).json({ message: "Server error" });
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

    return res.json({ token: jwtToken });
  } catch (error) {
    console.error("2FA ERROR:", error);
    return res.status(500).json({ message: "Қате" });
  }
};

module.exports = {
  sendCode,
  verifyCode,
  completeRegister,
  login,
  verifyLogin2FA,
};