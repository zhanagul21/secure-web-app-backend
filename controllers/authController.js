const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const speakeasy = require("speakeasy");
const { pool, connectDB } = require("../config/db");
const { sendVerificationEmail } = require("../utils/sendEmail");

// 1. Код жіберу
const sendCode = async (req, res) => {
  try {
    await connectDB();

    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email міндетті" });
    }

    const existing = await pool.query`
      SELECT * FROM users WHERE email = ${email}
    `;

    if (
      existing.recordset.length > 0 &&
      existing.recordset[0].is_verified === true
    ) {
      return res.status(400).json({ message: "Бұл email бұрын тіркелген" });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    if (existing.recordset.length > 0) {
      await pool.query`
        UPDATE users
        SET verification_code = ${code},
            code_expires_at = ${expiresAt}
        WHERE email = ${email}
      `;
    } else {
      await pool.query`
        INSERT INTO users (
          full_name,
          email,
          password_hash,
          role,
          is_verified,
          verification_code,
          code_expires_at
        )
        VALUES (
          ${""},
          ${email},
          ${""},
          ${"user"},
          ${false},
          ${code},
          ${expiresAt}
        )
      `;
    }

    await sendVerificationEmail(email, code);

    res.json({ message: "Растау коды email-ға жіберілді" });
  } catch (error) {
    console.error("Send code error:", error);
    res.status(500).json({ message: "Код жіберу кезінде қате шықты" });
  }
};

// 2. Кодты тексеру
const verifyCode = async (req, res) => {
  try {
    await connectDB();

    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ message: "Email және код міндетті" });
    }

    const result = await pool.query`
      SELECT * FROM users WHERE email = ${email}
    `;

    const user = result.recordset[0];

    if (!user) {
      return res.status(404).json({ message: "Пайдаланушы табылмады" });
    }

    if (user.verification_code !== code) {
      return res.status(400).json({ message: "Код қате" });
    }

    if (user.code_expires_at && new Date(user.code_expires_at) < new Date()) {
      return res.status(400).json({ message: "Код уақыты өтіп кеткен" });
    }

    res.json({ message: "Код расталды" });
  } catch (error) {
    console.error("Verify code error:", error);
    res.status(500).json({ message: "Сервер қатесі" });
  }
};

// 3. Тіркелуді аяқтау
const completeRegister = async (req, res) => {
  try {
    await connectDB();

    const { full_name, email, password } = req.body;

    if (!full_name || !email || !password) {
      return res.status(400).json({ message: "Барлық өрістер міндетті" });
    }

    const result = await pool.query`
      SELECT * FROM users WHERE email = ${email}
    `;

    const user = result.recordset[0];

    if (!user) {
      return res.status(404).json({ message: "Алдымен код сұратыңыз" });
    }

    if (!user.verification_code && user.is_verified !== true) {
      return res.status(400).json({ message: "Код расталмаған" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query`
      UPDATE users
      SET full_name = ${full_name},
          password_hash = ${hashedPassword},
          is_verified = ${true},
          verification_code = ${null},
          code_expires_at = ${null}
      WHERE email = ${email}
    `;

    res.json({ message: "Тіркелу сәтті аяқталды" });
  } catch (error) {
    console.error("Complete register error:", error);
    res.status(500).json({ message: "Сервер қатесі" });
  }
};

// 4. Login
const login = async (req, res) => {
  try {
    await connectDB();

    const { email, password } = req.body;

    console.log("LOGIN REQUEST EMAIL:", email);

    if (!email || !password) {
      return res.status(400).json({ message: "Email және пароль міндетті" });
    }

    const result = await pool.query`
      SELECT * FROM users WHERE email = ${email}
    `;

    const user = result.recordset[0];

    console.log("FOUND USER:", !!user);

    if (!user) {
      return res.status(400).json({ message: "Қате email немесе пароль" });
    }

    console.log("USER VERIFIED:", user.is_verified);
    console.log("HAS PASSWORD_HASH:", !!user.password_hash);
    console.log("HAS PASSWORD:", !!user.password);

    const storedHash = user.password_hash || user.password;

    if (!storedHash) {
      return res.status(500).json({
        message: "Пайдаланушы паролі базаға дұрыс сақталмаған",
      });
    }

    if (!user.is_verified) {
      return res.status(403).json({ message: "Аккаунт расталмаған" });
    }

    const isMatch = await bcrypt.compare(password, storedHash);

    console.log("PASSWORD MATCH:", isMatch);

    if (!isMatch) {
      return res.status(400).json({ message: "Қате email немесе пароль" });
    }

    if (user.twofa_enabled) {
      return res.json({
        requires2fa: true,
        message: "2FA кодын енгізіңіз",
        tempUser: {
          id: user.id,
          email: user.email,
          role: user.role,
        },
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    await pool.query`
      INSERT INTO activity_logs (user_id, action_type, action_details)
      VALUES (${user.id}, 'LOGIN', ${`Кіру орындалды: ${user.email}`})
    `;

    res.json({
      message: "Кіру сәтті орындалды",
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Сервер қатесі" });
  }
};

// 5. Login үшін 2FA растау
const verifyLogin2FA = async (req, res) => {
  try {
    await connectDB();

    const { email, token: twofaCode } = req.body;

    if (!email || !twofaCode) {
      return res.status(400).json({ message: "Email және 2FA коды міндетті" });
    }

    const result = await pool.query`
      SELECT * FROM users WHERE email = ${email}
    `;

    const user = result.recordset[0];

    if (!user) {
      return res.status(404).json({ message: "Пайдаланушы табылмады" });
    }

    if (!user.twofa_enabled || !user.twofa_secret) {
      return res.status(400).json({ message: "2FA қосылмаған" });
    }

    const verified = speakeasy.totp.verify({
      secret: user.twofa_secret,
      encoding: "base32",
      token: twofaCode,
      window: 1,
    });

    if (!verified) {
      return res.status(400).json({ message: "2FA коды қате" });
    }

    const jwtToken = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    await pool.query`
      INSERT INTO activity_logs (user_id, action_type, action_details)
      VALUES (${user.id}, 'LOGIN_2FA', ${`2FA арқылы кіру: ${user.email}`})
    `;

    res.json({
      message: "2FA арқылы кіру сәтті орындалды",
      token: jwtToken,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Verify login 2FA error:", error);
    res.status(500).json({ message: "Сервер қатесі" });
  }
};

module.exports = {
  sendCode,
  verifyCode,
  completeRegister,
  login,
  verifyLogin2FA,
};