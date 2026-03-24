const express = require("express");
const router = express.Router();

const {
  viewDocument,
  downloadDocument,
} = require("../controllers/documentController");

// Құжатты сайт ішінде ашу
router.get("/view/:name", viewDocument);

// Құжатты жүктеу
router.get("/download/:name", downloadDocument);

module.exports = router;