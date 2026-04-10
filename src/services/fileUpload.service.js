const logger = require("../utils/logger");
const { getClientConnection } = require("./database.service");
const { uploadToGoogleDrive, uploadToOneDrive } = require("./googleDrive.service");

const FILE_TABLE = "file";

// ─── Table columns that we persist ──────────────────────────────────────────
const FILE_TABLE_COLUMNS = [
  "availablewithoutlogin",
  "companywideusage",
  "created",
  "description",
  "documentsize",
  "externalid",
  "filetype",
  "folder",
  "folder_path",
  "hostedpath",
  "internalid",
  "isavailable",
  "modified",
  "name",
  "owner",
  "unique_key",
  "url",
];

/**
 * Ensure the `file` table exists in the client's database.
 * Creates it if it does not yet exist.
 */
const ensureFileTable = async (clientDb) => {
  const exists = await clientDb.schema.hasTable(FILE_TABLE);
  if (exists) return;

  logger.info(`📋 Creating '${FILE_TABLE}' table in client database...`);

  await clientDb.schema.createTable(FILE_TABLE, (table) => {
    table.increments("id").primary();
    table.string("unique_key", 255).unique().notNullable();
    table.string("internalid", 255);
    table.string("name", 500);
    table.string("folder", 255);
    table.text("folder_path");
    table.string("filetype", 100);
    table.string("documentsize", 50);
    table.boolean("isavailable").defaultTo(false);
    table.boolean("availablewithoutlogin").defaultTo(false);
    table.boolean("companywideusage").defaultTo(false);
    table.string("created", 100);
    table.text("description");
    table.string("externalid", 255);
    table.text("hostedpath");
    table.string("modified", 100);
    table.string("owner", 255);
    table.text("url");
    // Drive response fields
    table.string("drive_file_id", 255);
    table.string("drive_type", 50);
    table.text("drive_web_view_link");
    table.text("drive_web_content_link");
    table.string("drive_mime_type", 255);
    table.timestamps(true, true);
  });

  logger.info(`✅ '${FILE_TABLE}' table created.`);
};

/**
 * Extract the base64 data embedded in the multipart body string.
 * Returns null if not parseable (caller will skip re-upload).
 */
const extractBase64FromBody = (bodyStr, boundary) => {
  try {
    const delimiter = "--" + boundary.replace(/^-+/, "");
    const fullDelimiter = "--" + boundary;
    const parts = bodyStr.split(fullDelimiter).filter((p) => p.trim() && p.trim() !== "--");

    for (const part of parts) {
      if (
        !part.includes("application/json") &&
        (part.includes("application/octet-stream") || !part.includes("Content-Type: application/json"))
      ) {
        const dataMatch = part.match(/\r?\n\r?\n([\s\S]+)/);
        if (dataMatch) return dataMatch[1].trim();
      }
    }
  } catch (e) {
    logger.warn("⚠️ Could not extract base64 from body: " + e.message);
  }
  return null;
};

/**
 * Process a single file item:
 *  1. Detect drive type (google / onedrive)
 *  2. Upload binary to the appropriate drive
 *  3. Upsert record into the client's `file` table
 */
const processFileItem = async (fileItem, clientDb) => {
  const { exportdrive, ...fileData } = fileItem;

  if (!exportdrive || !exportdrive.Exportdrive) {
    throw new Error(`Missing exportdrive config for file: ${fileItem.name}`);
  }

  const driveConfig = exportdrive.Exportdrive;
  const driveType = (driveConfig["Drive type"] || "google drive").toLowerCase();

  logger.info(`🔄 Processing file: ${fileItem.name} | Drive: ${driveType}`);

  // ── Step 1: Upload to Drive ─────────────────────────────────────────────
  let driveResponse;

  if (driveType.includes("google")) {
    driveResponse = await uploadToGoogleDrive(null, driveConfig);
  } else if (driveType.includes("onedrive") || driveType.includes("one drive")) {
    // Extract binary from multipart body for OneDrive simple upload
    const boundary = extractBoundaryFromContentType(driveConfig.Headers["Content-Type"]);
    const base64 = boundary ? extractBase64FromBody(driveConfig.body, boundary) : null;
    const buffer = base64 ? Buffer.from(base64, "base64") : Buffer.alloc(0);
    driveResponse = await uploadToOneDrive(buffer, driveConfig);
  } else {
    throw new Error(`Unsupported drive type: ${driveType}`);
  }

  // ── Step 2: Build DB record ─────────────────────────────────────────────
  const record = {
    unique_key: String(fileItem.unique_key || fileItem.internalid),
    internalid: String(fileItem.internalid || ""),
    name: fileItem.name || null,
    folder: fileItem.folder ? String(fileItem.folder) : null,
    folder_path: null, // Not provided in payload; can be enriched later
    filetype: fileItem.filetype || null,
    documentsize: fileItem.documentsize ? String(fileItem.documentsize) : null,
    isavailable: Boolean(fileItem.isavailable),
    availablewithoutlogin: Boolean(fileItem.availablewithoutlogin),
    companywideusage: Boolean(fileItem.companywideusage),
    created: fileItem.created || null,
    description: fileItem.description || null,
    externalid: fileItem.externalid || null,
    hostedpath: fileItem.hostedpath ? fileItem.hostedpath.trim() : null,
    modified: fileItem.modified || null,
    owner: fileItem.owner || null,
    url: fileItem.url || null,
    // Drive response
    drive_file_id: driveResponse.id || driveResponse.fileId || null,
    drive_type: driveType,
    drive_web_view_link: driveResponse.webViewLink || null,
    drive_web_content_link: driveResponse.webContentLink || null,
    drive_mime_type: driveResponse.mimeType || null,
  };

  // ── Step 3: Upsert into `file` table ───────────────────────────────────
  await clientDb(FILE_TABLE).insert(record).onConflict("unique_key").merge();

  logger.info(`✅ File record saved: unique_key=${record.unique_key}, drive_file_id=${record.drive_file_id}`);

  return {
    unique_key: record.unique_key,
    name: record.name,
    drive_file_id: record.drive_file_id,
    drive_type: record.drive_type,
    drive_web_view_link: record.drive_web_view_link,
  };
};

function extractBoundaryFromContentType(contentType) {
  if (!contentType) return null;
  const match = contentType.match(/boundary=([^\s;]+)/);
  return match ? match[1] : null;
}

module.exports = { processFileItem, ensureFileTable, FILE_TABLE };
