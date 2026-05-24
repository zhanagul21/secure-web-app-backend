const jwt = require("jsonwebtoken");
const { isAccessTokenBlacklisted } = require("../utils/tokenStore");

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Токен жоқ" });
  }
  const token = authHeader.split(" ")[1];
  try {
    if (await isAccessTokenBlacklisted(token)) {
      return res.status(401).json({ message: "Сессия аяқталған. Қайта кіріңіз." });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== "access") {
      return res.status(401).json({ message: "Жарамсыз токен түрі" });
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Жарамсыз токен" });
  }
};

module.exports = { verifyToken };
