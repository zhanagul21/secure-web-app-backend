require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");

const { connectDB, dbDriver } = require("./config/db");
const { verifyEmailTransporter } = require("./utils/sendEmail");
const { bootstrapDefaultUser } = require("./utils/bootstrapUser");

const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const documentsRoutes = require("./routes/documentsRoutes");
const logsRoutes = require("./routes/logsRoutes");

const app = express();
const execFileAsync = promisify(execFile);

app.set("trust proxy", 1);

const uploadsPath = path.resolve(process.env.UPLOADS_DIR || "./uploads");
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!fs.existsSync(uploadsPath)) {
  fs.mkdirSync(uploadsPath, { recursive: true });
}

const getLibreOfficeExecutable = () => {
  const configuredPath = process.env.LIBREOFFICE_PATH;

  if (configuredPath && (process.platform === "win32" || !configuredPath.includes(":\\"))) {
    return configuredPath;
  }

  return process.platform === "win32" ? "soffice.exe" : "soffice";
};

const getLibreOfficeCandidates = () => {
  const candidates = [
    getLibreOfficeExecutable(),
    "/usr/bin/libreoffice",
    "/usr/bin/soffice",
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    process.platform === "win32" ? "libreoffice.exe" : "libreoffice",
    process.platform === "win32" ? "soffice.exe" : "soffice",
  ];

  return [...new Set(candidates.filter(Boolean))];
};

let libreOfficeHealth = {
  checkedAt: 0,
  result: { available: false, version: "" },
};

const getLibreOfficeHealth = async () => {
  const now = Date.now();

  if (now - libreOfficeHealth.checkedAt < 60_000) {
    return libreOfficeHealth.result;
  }

  let lastError = null;

  try {
    let version = "";

    for (const executable of getLibreOfficeCandidates()) {
      try {
        const { stdout, stderr } = await execFileAsync(
          executable,
          ["--version"],
          {
            timeout: 15000,
            env: { ...process.env, HOME: process.env.HOME || require("os").tmpdir() },
          }
        );
        version =
          (stdout || stderr || "").trim().split(/\r?\n/)[0] ||
          `${executable} available`;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!version) {
      throw lastError || new Error("LibreOffice not available");
    }

    libreOfficeHealth = {
      checkedAt: now,
      result: { available: true, version },
    };
  } catch (error) {
    libreOfficeHealth = {
      checkedAt: now,
      result: { available: false, version: "" },
    };
  }

  return libreOfficeHealth.result;
};

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

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use("/uploads", express.static(uploadsPath));

app.get("/", (req, res) => {
  res.send("AUTHGUARD BACKEND WORKING");
});

app.get("/api/health", async (req, res) => {
  res.json({
    ok: true,
    db: dbDriver,
    documentStorage: dbDriver === "postgres" ? "database" : "filesystem",
    officePreviewRevision: "2026-05-22-v6-libreoffice-doc-preview",
    libreOffice: await getLibreOfficeHealth(),
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
  await bootstrapDefaultUser();
  await verifyEmailTransporter();

  app.listen(PORT, "0.0.0.0", () => {
    console.log("SERVER RUNNING ON PORT:", PORT);
    console.log("UPLOADS PATH:", uploadsPath);
  });
});
