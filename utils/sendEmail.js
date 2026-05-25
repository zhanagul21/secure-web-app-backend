const nodemailer = require("nodemailer");

const smtpUser = process.env.GMAIL_USER;
const smtpPass = process.env.GMAIL_APP_PASSWORD;
const defaultFrom = process.env.MAIL_FROM || `"AuthGuard Locker" <${smtpUser}>`;
const resendApiKey = process.env.RESEND_API_KEY;
const resendApiUrl = process.env.RESEND_API_URL || "https://api.resend.com/emails";

const gmailClientId = process.env.GMAIL_API_CLIENT_ID;
const gmailClientSecret = process.env.GMAIL_API_CLIENT_SECRET;
const gmailRefreshToken = process.env.GMAIL_API_REFRESH_TOKEN;
const canUseOAuth2 = Boolean(gmailClientId && gmailClientSecret && gmailRefreshToken && smtpUser);
const canUseSmtp = Boolean(smtpUser && smtpPass);

const buildOAuth2Transporter = () =>
  nodemailer.createTransport({
    service: "gmail",
    auth: {
      type: "OAuth2",
      user: smtpUser,
      clientId: gmailClientId,
      clientSecret: gmailClientSecret,
      refreshToken: gmailRefreshToken,
    },
    family: 4,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });

const buildSmtpTransporter = () =>
  nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user: smtpUser, pass: smtpPass },
    family: 4,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });

async function sendViaResend(to, subject, html) {
  const response = await fetch(resendApiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || process.env.RESEND_FROM_EMAIL || smtpUser,
      to: [to],
      subject,
      html,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || "Resend email request failed");
    error.code = payload?.name || `HTTP_${response.status}`;
    throw error;
  }
  return payload;
}

const verifyEmailTransporter = async () => {
  if (canUseOAuth2) { console.log("MAILER READY: gmail-oauth2"); return; }
  if (resendApiKey) { console.log("MAILER READY: resend-api"); return; }
  if (canUseSmtp) { console.log("MAILER READY: gmail-smtp"); return; }
  console.error("MAILER VERIFY ERROR: no email transport configured");
};

const sendMail = async (to, subject, html) => {
  if (resendApiKey) return sendViaResend(to, subject, html);
  if (canUseOAuth2) {
    try {
      return await buildOAuth2Transporter().sendMail({ from: defaultFrom, to, subject, html });
    } catch (err) {
      console.error("GMAIL OAUTH2 ERROR:", err.message);
    }
  }
  if (canUseSmtp) return await buildSmtpTransporter().sendMail({ from: defaultFrom, to, subject, html });
  throw new Error("Email transport is unavailable");
};

module.exports = { sendMail, verifyEmailTransporter };
