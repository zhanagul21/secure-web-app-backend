require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const { connectDB, ensureSchema } = require("./config/db");

const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const documentsRoutes = require("./routes/documentsRoutes");
const logsRoutes = require("./routes/logsRoutes");

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(helmet());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("AUTHGUARD LOCKER API is running");
});

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/documents", documentsRoutes);
app.use("/api/logs", logsRoutes);

const PORT = process.env.PORT || 10000;

const startServer = async () => {
  try {
    await connectDB();
    await ensureSchema();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("SERVER START ERROR:", error);
    process.exit(1);
  }
};

startServer();