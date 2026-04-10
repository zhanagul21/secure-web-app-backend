const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const speakeasy = require("speakeasy");
const nodemailer = require("nodemailer");
const { sql } = require("../config/db");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function logActivity(userId, actionType, actionDetails) {
  try {
    if (!userId) return;
    await sql.query`
      INSERT INTO activity_logs (user_id, action_type, action_details, created_at)
      VALUES (${userId}, ${actionType}, ${actionDetails}, GETDATE())
    `;
  } catch (error) {
    console.error("LOG ACTIVITY ERROR:", error);
  }
}

function generateSixDigitCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role || "user",
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

async function sendMail(to, subject, html) {
  await transporter.sendMail({
    from: `"AuthGuard Locker" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    html,
  });
}

const sendCode = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ message: "Email міндетті" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existing = await sql.query`
      SELECT * FROM users WHERE email = ${normalizedEmail}
    `;

    if (
      existing.recordset.length > 0 &&
      existing.recordset[0].password_hash &&
      existing.recordset[0].is_verified
    ) {
      return res.status(400).json({
        message: "Бұл email-пен аккаунт бұрыннан тіркелген",
      });
    }

    const code = generateSixDigitCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    if (existing.recordset.length === 0) {
      await sql.query`
        INSERT INTO users (
          full_name,
          email,
          password_hash,
          role,
          is_verified,
          verification_code,
          code_expires_at,
          created_at
        )
        VALUES (
          ${null},
          ${normalizedEmail},
          ${""},
          ${"user"},
          ${0},
          ${code},
          ${expiresAt},
          GETDATE()
        )
      `;
    } else {
      await sql.query`
        UPDATE users
        SET verification_code = ${code},
            code_expires_at = ${expiresAt},
            is_verified = 0
        WHERE email = ${normalizedEmail}
      `;
    }

    await sendMail(
      normalizedEmail,
      "AuthGuard Locker - Растау коды",
      `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>AuthGuard Locker</h2>
          <p>Сіздің растау кодыңыз:</p>
          <h1 style="letter-spacing: 4px; color: #2563eb;">${code}</h1>
          <p>Бұл код 10 минут ішінде жарамды.</p>
        </div>
      `
    );

    return res.json({
      message: "Код email-ге жіберілді",
      email: normalizedEmail,
    });
  } catch (error) {
    console.error("SEND CODE ERROR:", error);
    return res.status(500).json({
      message: "Код жіберу кезінде қате шықты",
      error: error.message,
    });
  }
};

const verifyCode = async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ message: "Email мен код міндетті" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const result = await sql.query`
      SELECT * FROM users WHERE email = ${normalizedEmail}
    `;

    const user = result.recordset[0];

    if (!user) {
      return res.status(404).json({ message: "Қолданушы табылмады" });
    }

    if (!user.verification_code || user.verification_code !== code.trim()) {
      return res.status(400).json({ message: "Код қате" });
    }

    if (!user.code_expires_at || new Date(user.code_expires_at) < new Date()) {
      return res.status(400).json({ message: "Кодтың жарамдылық уақыты өтті" });
    }

    return res.json({ message: "Код сәтті расталды" });
  } catch (error) {
    console.error("VERIFY CODE ERROR:", error);
    return res.status(500).json({
      message: "Кодты тексеру кезінде қате шықты",
      error: error.message,
    });
  }
};

const register = async (req, res) => {
  try {
    const { full_name, email, password } = req.body;

    if (!full_name || !email || !password) {
      return res.status(400).json({ message: "Барлық өрістерді толтырыңыз" });
    }

    if (password.length < 6) {
      return res.status(400).json({
        message: "Құпия сөз кемінде 6 таңбадан тұруы керек",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const fullName = full_name.trim();

    const result = await sql.query`
      SELECT * FROM users WHERE email = ${normalizedEmail}
    `;

    const user = result.recordset[0];

    if (!user) {
      return res.status(400).json({
        message: "Алдымен email растау кодын жіберіңіз",
      });
    }

    if (!user.verification_code || !user.code_expires_at) {
      return res.status(400).json({
        message: "Алдымен email кодын растаңыз",
      });
    }

    if (new Date(user.code_expires_at) < new Date()) {
      return res.status(400).json({
        message: "Кодтың жарамдылық уақыты өтіп кетті. Қайта код жіберіңіз",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    await sql.query`
      UPDATE users
      SET full_name = ${fullName},
          password_hash = ${hashedPassword},
          role = ${user.role || "user"},
          is_verified = 1,
          verification_code = NULL,
          code_expires_at = NULL
      WHERE email = ${normalizedEmail}
    `;

    const updatedResult = await sql.query`
      SELECT * FROM users WHERE email = ${normalizedEmail}
    `;

    const savedUser = updatedResult.recordset[0];

    await logActivity(savedUser.id, "REGISTER", `Тіркелу: ${normalizedEmail}`);

    return res.json({
      message: "Тіркелу сәтті аяқталды",
    });
  } catch (error) {
    console.error("REGISTER ERROR:", error);
    return res.status(500).json({
      message: "Тіркелу кезінде қате шықты",
      error: error.message,
    });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email мен пароль міндетті" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const result = await sql.query`
      SELECT * FROM users WHERE email = ${normalizedEmail}
    `;

    const user = result.recordset[0];

    if (!user || !user.password_hash) {
      return res.status(400).json({ message: "Қате email немесе пароль" });
    }

    if (!user.is_verified) {
      return res.status(403).json({
        message: "Аккаунт расталмаған. Тіркелуді аяқтаңыз",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(400).json({ message: "Қате email немесе пароль" });
    }

    if (user.twofa_enabled && user.twofa_secret) {
      return res.json({
        requires2fa: true,
        email: user.email,
        message: "2FA кодын енгізіңіз",
      });
    }

    const token = signToken(user);

    await logActivity(user.id, "LOGIN", `Жүйеге кірді: ${user.email}`);

    return res.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
        twofa_enabled: user.twofa_enabled,
      },
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    return res.status(500).json({
      message: "Кіру кезінде қате шықты",
      error: error.message,
    });
  }
};

const verify2FA = async (req, res) => {
  try {
    const { email, token } = req.body;

    if (!email || !token) {
      return res.status(400).json({ message: "Email мен 2FA коды міндетті" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const result = await sql.query`
      SELECT * FROM users WHERE email = ${normalizedEmail}
    `;

    const user = result.recordset[0];

    if (!user) {
      return res.status(404).json({ message: "Қолданушы табылмады" });
    }

    if (!user.twofa_enabled || !user.twofa_secret) {
      return res.status(400).json({ message: "2FA бұл аккаунтта қосылмаған" });
    }

    const verified = speakeasy.totp.verify({
      secret: user.twofa_secret,
      encoding: "base32",
      token: token.trim(),
      window: 1,
    });

    if (!verified) {
      return res.status(400).json({ message: "2FA коды қате" });
    }

    const jwtToken = signToken(user);

    await logActivity(user.id, "LOGIN", `2FA арқылы кірді: ${user.email}`);

    return res.json({
      token: jwtToken,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
        twofa_enabled: user.twofa_enabled,
      },
    });
  } catch (error) {
    console.error("VERIFY 2FA ERROR:", error);
    return res.status(500).json({
      message: "2FA тексеру кезінде қате шықты",
      error: error.message,
    });
  }
};

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ message: "Email міндетті" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const result = await sql.query`
      SELECT * FROM users WHERE email = ${normalizedEmail}
    `;

    const user = result.recordset[0];

    if (!user) {
      return res.status(404).json({ message: "Бұл email бойынша аккаунт табылмады" });
    }

    const code = generateSixDigitCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await sql.query`
      UPDATE users
      SET reset_code = ${code},
          reset_code_expires = ${expiresAt}
      WHERE email = ${normalizedEmail}
    `;

    await sendMail(
      normalizedEmail,
      "AuthGuard Locker - Құпия сөзді қалпына келтіру",
      `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Құпия сөзді қалпына келтіру</h2>
          <p>Сіздің қалпына келтіру кодыңыз:</p>
          <h1 style="letter-spacing: 4px; color: #2563eb;">${code}</h1>
          <p>Бұл код 10 минут ішінде жарамды.</p>
        </div>
      `
    );

    return res.json({
      message: "Құпия сөзді қалпына келтіру коды email-ге жіберілді",
    });
  } catch (error) {
    console.error("FORGOT PASSWORD ERROR:", error);
    return res.status(500).json({
      message: "Қалпына келтіру кодын жіберу кезінде қате шықты",
      error: error.message,
    });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({
        message: "Email, код және жаңа пароль міндетті",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        message: "Жаңа құпия сөз кемінде 6 таңба болуы керек",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const result = await sql.query`
      SELECT * FROM users WHERE email = ${normalizedEmail}
    `;

    const user = result.recordset[0];

    if (!user) {
      return res.status(404).json({ message: "Қолданушы табылмады" });
    }

    if (!user.reset_code || user.reset_code !== code.trim()) {
      return res.status(400).json({ message: "Қалпына келтіру коды қате" });
    }

    if (
      !user.reset_code_expires ||
      new Date(user.reset_code_expires) < new Date()
    ) {
      return res.status(400).json({
        message: "Қалпына келтіру кодының уақыты өтіп кеткен",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await sql.query`
      UPDATE users
      SET password_hash = ${hashedPassword},
          reset_code = NULL,
          reset_code_expires = NULL
      WHERE email = ${normalizedEmail}
    `;

    await logActivity(user.id, "PASSWORD_RESET", `Пароль жаңартылды: ${user.email}`);

    return res.json({
      message: "Құпия сөз сәтті жаңартылды",
    });
  } catch (error) {
    console.error("RESET PASSWORD ERROR:", error);
    return res.status(500).json({
      message: "Парольді жаңарту кезінде қате шықты",
      error: error.message,
    });
  }
};

module.exports = {
  sendCode,
  verifyCode,
  register,
  login,
  verify2FA,
  forgotPassword,
  resetPassword,
};