const express = require("express");
const rateLimit = require("express-rate-limit");
const { body, validationResult } = require("express-validator");
const router = express.Router();
const { verifyToken } = require("../middleware/authMiddleware");

const {
  sendCode,
  verifyCode,
  register,
  registerDirect,
  login,
  verify2FA,
  refreshToken,
  logout,
  forgotPassword,
  resetPassword,
} = require("../controllers/authController");

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Тым көп сұраныс. 15 минуттан кейін қайталаңыз." },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Кіру әрекеті тым көп. 15 минуттан кейін қайталаңыз." },
});

const codeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Код сұрату тым жиі. 10 минуттан кейін қайталаңыз." },
});

const validate = (rules) => [
  ...rules,
  (req, res, next) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: errors.array()[0]?.msg || "Енгізілген деректер дұрыс емес",
      });
    }

    next();
  },
];

const emailRule = () => body("email")
  .isEmail()
  .withMessage("Email форматы дұрыс емес")
  .normalizeEmail();

const passwordRule = () => body("password")
  .isLength({ min: 8 })
  .withMessage("Құпия сөз кемінде 8 таңбадан тұруы керек")
  .matches(/[A-ZА-ЯЁ]/)
  .withMessage("Құпия сөзде кемінде бір бас әріп болуы керек")
  .matches(/[a-zа-яё]/)
  .withMessage("Құпия сөзде кемінде бір кіші әріп болуы керек")
  .matches(/\d/)
  .withMessage("Құпия сөзде кемінде бір сан болуы керек");

router.post("/send-code", codeLimiter, validate([emailRule()]), sendCode);
router.post(
  "/verify-code",
  authLimiter,
  validate([
    emailRule(),
    body("code").trim().isLength({ min: 6, max: 6 }).withMessage("Код 6 таңбадан тұруы керек"),
  ]),
  verifyCode
);
router.post(
  "/complete-register",
  authLimiter,
  validate([
    body("full_name").trim().isLength({ min: 2 }).withMessage("Аты-жөні кемінде 2 таңба болуы керек"),
    emailRule(),
    passwordRule(),
  ]),
  register
);
router.post(
  "/register-direct",
  authLimiter,
  validate([
    body("full_name").trim().isLength({ min: 2 }).withMessage("Аты-жөні кемінде 2 таңба болуы керек"),
    emailRule(),
    passwordRule(),
  ]),
  registerDirect
);
router.post(
  "/login",
  loginLimiter,
  validate([
    emailRule(),
    body("password").isLength({ min: 1 }).withMessage("Құпия сөз міндетті"),
  ]),
  login
);
router.post(
  "/login-2fa",
  loginLimiter,
  validate([
    body("tempToken").trim().notEmpty().withMessage("2FA сессиясы жоқ"),
    body("token").trim().isLength({ min: 6, max: 6 }).withMessage("2FA коды 6 таңбадан тұруы керек"),
  ]),
  verify2FA
);
router.post("/refresh", authLimiter, refreshToken);
router.post("/logout", verifyToken, logout);
router.post("/forgot-password", codeLimiter, validate([emailRule()]), forgotPassword);
router.post(
  "/reset-password",
  authLimiter,
  validate([
    emailRule(),
    body("code").trim().isLength({ min: 6, max: 6 }).withMessage("Код 6 таңбадан тұруы керек"),
    body("newPassword")
      .isLength({ min: 8 })
      .withMessage("Жаңа құпия сөз кемінде 8 таңбадан тұруы керек")
      .matches(/[A-ZА-ЯЁ]/)
      .withMessage("Жаңа құпия сөзде кемінде бір бас әріп болуы керек")
      .matches(/[a-zа-яё]/)
      .withMessage("Жаңа құпия сөзде кемінде бір кіші әріп болуы керек")
      .matches(/\d/)
      .withMessage("Жаңа құпия сөзде кемінде бір сан болуы керек"),
  ]),
  resetPassword
);

module.exports = router;
