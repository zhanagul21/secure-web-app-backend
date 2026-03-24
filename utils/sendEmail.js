const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

const sendVerificationEmail = async (to, code) => {
  await transporter.sendMail({
    from: `"AUTHGUARD LOCKER" <${process.env.GMAIL_USER}>`,
    to,
    subject: "AUTHGUARD LOCKER - Растау коды",
    html: `
      <div style="font-family: Arial, sans-serif; padding: 24px; background: #f8fafc;">
        <div style="max-width: 560px; margin: 0 auto; background: white; border-radius: 16px; padding: 32px; box-shadow: 0 10px 30px rgba(0,0,0,0.08);">
          <h1 style="margin: 0 0 12px; color: #0f172a;">AUTHGUARD LOCKER</h1>
          <p style="font-size: 16px; color: #334155; margin-bottom: 24px;">
            Қауіпсіз тіркелуді аяқтау үшін төмендегі растау кодын енгізіңіз:
          </p>

          <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; color: #0ea5e9; margin: 24px 0;">
            ${code}
          </div>

          <p style="font-size: 14px; color: #64748b;">
            Кодтың жарамдылық уақыты: 10 минут.
          </p>
        </div>
      </div>
    `,
  });
};

module.exports = { sendVerificationEmail };