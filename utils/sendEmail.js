const nodemailer = require("nodemailer");

const smtpUser = process.env.GMAIL_USER;
const smtpPass = process.env.GMAIL_APP_PASSWORD;
const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
const smtpFamily = Number.parseInt(process.env.SMTP_FAMILY || "4", 10);
const defaultFrom = process.env.MAIL_FROM || `"AuthGuard Locker" <${smtpUser}>`;

const buildTransporter = ({ secure, port }) =>
  nodemailer.createTransport({
    host: smtpHost,
    port,
    secure,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
    family: smtpFamily === 4 || smtpFamily === 6 ? smtpFamily : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    requireTLS: !secure,
    tls: {
      servername: smtpHost,
    },
  });

const transporters = [
  {
    name: "smtp-587",
    transporter: buildTransporter({
      secure: false,
      port: Number.parseInt(process.env.SMTP_PORT || "587", 10),
    }),
  },
  {
    name: "smtp-465",
    transporter: buildTransporter({
      secure: true,
      port: Number.parseInt(process.env.SMTP_SSL_PORT || "465", 10),
    }),
  },
];

const verifyEmailTransporter = async () => {
  for (const { name, transporter } of transporters) {
    try {
      await transporter.verify();
      console.log(`MAILER READY: ${name}`);
      return;
    } catch (error) {
      console.error(`MAILER VERIFY ERROR (${name}):`, error);
    }
  }
};

const sendMail = async (to, subject, html) => {
  let lastError;

  for (const { name, transporter } of transporters) {
    try {
      return await transporter.sendMail({
        from: defaultFrom,
        to,
        subject,
        html,
      });
    } catch (error) {
      lastError = error;
      console.error(`SEND MAIL ERROR (${name}):`, error);
    }
  }

  throw lastError || new Error("Email transport is unavailable");
};

module.exports = {
  sendMail,
  verifyEmailTransporter,
};
