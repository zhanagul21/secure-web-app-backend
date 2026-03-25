const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/authMiddleware");
const { pool } = require("../config/db");

router.get("/my", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query`
      SELECT id, action_type, action_details, created_at
      FROM activity_logs
      WHERE user_id = ${userId}
      ORDER BY id DESC
    `;

    res.json({ logs: result.recordset });
  } catch (error) {
    console.error("Get logs error:", error);
    res.status(500).json({ message: "Сервер қатесі" });
  }
});

module.exports = router;