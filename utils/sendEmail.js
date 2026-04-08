const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  requireTLS: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
  tls: {
    rejectUnauthorized: false,
  },
  family: 4,
});

const sendVerificationEmail = async (to, code) => {
  try {
    await transporter.sendMail({
      from: `"AuthGuard Locker" <${process.env.GMAIL_USER}>`,
      to,
      subject: "AuthGuard Locker - Растау коды",
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>AuthGuard Locker</h2>
          <p>Сіздің растау кодыңыз:</p>
          <h1 style="letter-spacing: 4px; color: #2563eb;">${code}</h1>
          <p>Бұл код 10 минут ішінде жарамды.</p>
        </div>
      `,
    });

    console.log("Verification email sent to:", to);
  } catch (error) {
    console.error("EMAIL SEND ERROR:", error);
    throw error;
  }
};

module.exports = { sendVerificationEmail };