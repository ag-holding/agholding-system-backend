const express = require("express");
const router = express.Router();
const apiKeyMiddleware = require("../middlewares/apiKey.middleware");
const fileUploadController = require("../controllers/fileUpload.controller");

/**
 * POST /api/files/upload
 *
 * Protected by API key middleware.
 * Accepts a JSON payload with accountId, uniqueKey, and data[].
 * Uploads each file in data[] to the configured cloud drive (Google Drive / OneDrive)
 * and saves the response metadata into the client's `file` table.
 */
router.post("/upload", fileUploadController.uploadFiles);

module.exports = router;
