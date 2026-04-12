const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/authMiddleware");
const { sql, pool, poolConnect } = require("../config/db");

router.get("/my", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;

    await poolConnect;

    const result = await pool
      .request()
      .input("userId", sql.Int, userId)
      .query(`
        SELECT id, action_type, action_details, created_at
        FROM activity_logs
        WHERE user_id = @userId
        ORDER BY id DESC
      `);

    res.json({ logs: result.recordset });
  } catch (error) {
    console.error("GET LOGS ERROR:", error);
    res.status(500).json({ message: "Логтарды жүктеу кезінде қате шықты" });
  }
});

module.exports = router;