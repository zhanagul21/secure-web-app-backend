const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/authMiddleware");
const { connectDB } = require("../config/db");

router.get("/my", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const db = await connectDB();

    const result = await db.query(
      `
      SELECT id, action_type, action_details, created_at
      FROM activity_logs
      WHERE user_id = $1
      ORDER BY id DESC
      `,
      [userId]
    );

    res.json({ logs: result.rows });
  } catch (error) {
    console.error("Get logs error:", error);
    res.status(500).json({ message: "Сервер қатесі" });
  }
});

module.exports = router;