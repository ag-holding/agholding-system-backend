const axios = require("axios");
const logger = require("../utils/logger");

/**
 * Upload a file to Google Drive using the multipart upload endpoint
 * provided dynamically in the payload (exportdrive config).
 *
 * @param {Buffer}  fileBuffer   - Binary buffer of the file
 * @param {Object}  driveConfig  - The `Exportdrive.Exportdrive` block from the payload
 * @returns {Object}             - Google Drive file metadata response
 */
const uploadToGoogleDrive = async (fileBuffer, driveConfig) => {
  const { endpointurl, RequestMethod, Headers, body } = driveConfig;
  const uploadUrl = endpointurl.requesturl;

  logger.info(`📤 Uploading to Google Drive: ${uploadUrl}`);

  // The body in the payload is a pre-built multipart string.
  // We must replace the base64 placeholder with the actual binary buffer
  // by reconstructing the multipart body properly.
  // However, since the payload already contains the base64 data embedded in `body`,
  // we parse the multipart body and rebuild it with binary content.

  const boundary = extractBoundary(Headers["Content-Type"]);

  if (!boundary) {
    throw new Error("Could not extract multipart boundary from Content-Type header");
  }

  // Parse the multipart body from the payload string to extract metadata JSON and base64 data
  const { metadataJson, base64Data } = parseMultipartBody(body, boundary);

  // Convert base64 to binary buffer
  const binaryBuffer = Buffer.from(base64Data.trim(), "base64");

  // Build a proper multipart/related body with binary data
  const multipartBody = buildMultipartBody(boundary, metadataJson, binaryBuffer);

  const response = await axios({
    method: RequestMethod.toLowerCase(),
    url: uploadUrl,
    headers: {
      Authorization: Headers.Authorization,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": multipartBody.length,
    },
    data: multipartBody,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  logger.info(`✅ Google Drive upload success. File ID: ${response.data.id}`);
  return response.data;
};

/**
 * Upload to OneDrive using Microsoft Graph API multipart upload.
 * Accepts a pre-built config block similar to Google Drive.
 *
 * @param {Buffer}  fileBuffer   - Binary buffer of the file
 * @param {Object}  driveConfig  - The OneDrive export config block
 * @returns {Object}             - OneDrive file metadata response
 */
const uploadToOneDrive = async (fileBuffer, driveConfig) => {
  const { endpointurl, RequestMethod, Headers, body, fileName } = driveConfig;
  const uploadUrl = endpointurl.requesturl;

  logger.info(`📤 Uploading to OneDrive: ${uploadUrl}`);

  const response = await axios({
    method: RequestMethod.toLowerCase(),
    url: uploadUrl,
    headers: {
      Authorization: Headers.Authorization,
      "Content-Type": Headers["Content-Type"] || "application/octet-stream",
    },
    data: fileBuffer,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  logger.info(`✅ OneDrive upload success.`);
  return response.data;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract the boundary value from a Content-Type header like:
 * "multipart/related; boundary=-------314159265358979323846"
 */
function extractBoundary(contentType) {
  if (!contentType) return null;
  const match = contentType.match(/boundary=([^\s;]+)/);
  return match ? match[1] : null;
}

/**
 * Parse the pre-built multipart body string from the payload.
 * Extracts the JSON metadata part and the base64 binary part.
 */
function parseMultipartBody(bodyStr, boundary) {
  // Split on the boundary dashes (the body uses "--" + boundary)
  const delimiter = "--" + boundary;
  const parts = bodyStr.split(delimiter).filter((p) => p.trim() && p.trim() !== "--");

  let metadataJson = null;
  let base64Data = null;

  for (const part of parts) {
    if (part.includes("application/json")) {
      // Extract JSON after double CRLF
      const jsonMatch = part.match(/\r?\n\r?\n([\s\S]+)/);
      if (jsonMatch) {
        metadataJson = jsonMatch[1].trim();
      }
    } else if (
      part.includes("application/octet-stream") ||
      (!part.includes("Content-Type: application/json") && part.includes("Content-Type:"))
    ) {
      const dataMatch = part.match(/\r?\n\r?\n([\s\S]+)/);
      if (dataMatch) {
        base64Data = dataMatch[1].trim();
      }
    } else if (!part.includes("Content-Type:") && part.trim()) {
      // Part without explicit Content-Type is likely the binary data
      const dataMatch = part.match(/\r?\n\r?\n([\s\S]+)/);
      if (dataMatch) {
        base64Data = dataMatch[1].trim();
      } else {
        base64Data = part.trim();
      }
    }
  }

  if (!metadataJson) throw new Error("Could not parse metadata JSON from multipart body");
  if (!base64Data) throw new Error("Could not parse base64 data from multipart body");

  return { metadataJson, base64Data };
}

/**
 * Build a binary-safe multipart/related Buffer from metadata JSON + binary file data.
 */
function buildMultipartBody(boundary, metadataJson, binaryBuffer) {
  const CRLF = "\r\n";
  const dash = "--";

  const metaPart =
    dash +
    boundary +
    CRLF +
    "Content-Type: application/json; charset=UTF-8" +
    CRLF +
    CRLF +
    metadataJson +
    CRLF;

  const binaryHeader =
    dash + boundary + CRLF + "Content-Type: application/octet-stream" + CRLF + CRLF;

  const closing = CRLF + dash + boundary + dash + CRLF;

  return Buffer.concat([
    Buffer.from(metaPart, "utf8"),
    Buffer.from(binaryHeader, "utf8"),
    binaryBuffer,
    Buffer.from(closing, "utf8"),
  ]);
}

module.exports = { uploadToGoogleDrive, uploadToOneDrive };
