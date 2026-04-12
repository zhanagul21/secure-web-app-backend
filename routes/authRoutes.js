const express = require("express");
const router = express.Router();

const {
  sendCode,
  verifyCode,
  register,
  login,
  verify2FA,
  forgotPassword,
  resetPassword,
} = require("../controllers/authController");

router.post("/send-code", sendCode);
router.post("/verify-code", verifyCode);
router.post("/complete-register", register);
router.post("/login", login);
router.post("/login-2fa", verify2FA);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

module.exports = router;