const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

const verifyEmailTransporter = async () => {
  try {
    await transporter.verify();
    console.log("MAILER READY");
  } catch (error) {
    console.error("MAILER VERIFY ERROR:", error);
  }
};

const sendMail = async (to, subject, html) => {
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to,
    subject,
    html,
  });
};

module.exports = {
  sendMail,
  verifyEmailTransporter,
};