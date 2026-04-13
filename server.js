require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs");

const { connectDB, dbDriver } = require("./config/db");
const { verifyEmailTransporter } = require("./utils/sendEmail");

const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const documentsRoutes = require("./routes/documentsRoutes");
const logsRoutes = require("./routes/logsRoutes");

const app = express();

const uploadsPath = path.resolve(process.env.UPLOADS_DIR || "./uploads");
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!fs.existsSync(uploadsPath)) {
  fs.mkdirSync(uploadsPath, { recursive: true });
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    exposedHeaders: ["X-Expires-At"],
  })
);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(uploadsPath));

app.get("/", (req, res) => {
  res.send("AUTHGUARD BACKEND WORKING");
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    db: dbDriver,
    documentStorage: dbDriver === "postgres" ? "database" : "filesystem",
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/documents", documentsRoutes);
app.use("/api/logs", logsRoutes);

app.use((req, res) => {
  res.status(404).json({ message: "Route табылмады" });
});

app.use((err, req, res, next) => {
  console.error("UNHANDLED SERVER ERROR:", err);
  res.status(500).json({ message: "Server error" });
});

const PORT = process.env.PORT || 5000;

connectDB().then(async () => {
  await verifyEmailTransporter();

  app.listen(PORT, "0.0.0.0", () => {
    console.log("SERVER RUNNING ON PORT:", PORT);
    console.log("UPLOADS PATH:", uploadsPath);
  });
});
