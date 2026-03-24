const express = require("express");
const router = express.Router();

const {
  sendCode,
  verifyCode,
  completeRegister,
  login,
  verifyLogin2FA,
} = require("../controllers/authController");

router.post("/send-code", sendCode);
router.post("/verify-code", verifyCode);
router.post("/complete-register", completeRegister);
router.post("/login", login);
router.post("/login-2fa", verifyLogin2FA);

module.exports = router;