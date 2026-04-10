const axios = require("axios");

/**
 * Map NetSuite filetype or filename to file extension.
 */
function getExtensionFromType(fileTypeOrName) {
  if (!fileTypeOrName) return null;
  const val = fileTypeOrName.trim().toUpperCase();

  // If it already has a dot, extract the extension
  if (fileTypeOrName.includes(".")) {
    const ext = fileTypeOrName.split(".").pop().toLowerCase();
    return "." + ext;
  }

  const extMap = {
    // ── Standard short types ──
    PNG: ".png",
    JPG: ".jpg",
    JPEG: ".jpg",
    GIF: ".gif",
    BMP: ".bmp",
    TIFF: ".tiff",
    SVG: ".svg",
    WEBP: ".webp",
    PDF: ".pdf",
    CSV: ".csv",
    PLAINTEXT: ".txt",
    TXT: ".txt",
    WORD: ".docx",
    EXCEL: ".xlsx",
    POWERPOINT: ".pptx",
    HTMLDOC: ".html",
    HTML: ".html",
    XML: ".xml",
    JSON: ".json",
    ZIP: ".zip",
    GZIP: ".gz",
    TAR: ".tar",
    MP3: ".mp3",
    MP4: ".mp4",
    AVI: ".avi",
    MOV: ".mov",
    XMLDOC: ".xml",
    STYLESHEET: ".css",
    JAVASCRIPT: ".js",
    RTF: ".rtf",
    SCSS: ".scss",
    XSD: ".xsd",

    // ── NetSuite file.Type enum values ──
    APPCACHE: ".appcache",
    AUTOCAD: ".dwg",
    BMPIMAGE: ".bmp",
    CERTIFICATE: ".pem",
    CONFIG: ".config",
    CSVFILE: ".csv",
    FLASH: ".swf",
    FREEMARKER: ".ftl",
    GIFIMAGE: ".gif",
    ICON: ".ico",
    IMAGE: ".png",
    JPGIMAGE: ".jpg",
    MESSAGERFC: ".eml",
    MISCBINARY: ".bin",
    MISCTEXT: ".txt",
    MPEGMOVIE: ".mpg",
    MSPROJECT: ".mpp",
    PDFFILE: ".pdf",
    PJPGIMAGE: ".jpg",
    PNGIMAGE: ".png",
    POSTSCRIPT: ".ps",
    QUICKTIME: ".mov",
    SMS: ".txt",
    SVGIMAGE: ".svg",
    TIFFIMAGE: ".tiff",
    VISIO: ".vsd",
    WEBAPPPAGE: ".html",
    WEBAPPSCRIPT: ".js",
    WEBPIMAGE: ".webp",
  };
  return extMap[val] || null;
}

/**
 * Get MIME type from filename.
 */
function getMimeType(filename) {
  if (!filename) return null;
  const ext = (filename.includes(".") ? filename.split(".").pop() : filename).toLowerCase();
  const mimeMap = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    webp: "image/webp",
    tiff: "image/tiff",
    ico: "image/x-icon",
    pdf: "application/pdf",
    csv: "text/csv",
    txt: "text/plain",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    html: "text/html",
    xml: "application/xml",
    json: "application/json",
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    avi: "video/x-msvideo",
    mov: "video/quicktime",
    mpg: "video/mpeg",
    css: "text/css",
    js: "application/javascript",
    scss: "text/x-scss",
    rtf: "application/rtf",
    xsd: "application/xml",
    appcache: "text/cache-manifest",
    dwg: "application/acad",
    pem: "application/x-pem-file",
    config: "text/plain",
    swf: "application/x-shockwave-flash",
    ftl: "text/plain",
    eml: "message/rfc822",
    bin: "application/octet-stream",
    ps: "application/postscript",
    mpp: "application/vnd.ms-project",
    vsd: "application/vnd.visio",
  };
  return mimeMap[ext] || null;
}

/**
 * Check if the body is a raw base64 string (no multipart structure).
 */
function isRawBase64(body) {
  const trimmed = body.trim();
  return /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed);
}

/**
 * Extract base64 string from body.
 */
function extractBase64FromBody(body) {
  const trimmed = body.trim();

  if (isRawBase64(trimmed)) {
    console.log("Body is raw base64 string");
    return trimmed.replace(/\r?\n/g, "");
  }

  console.log("Body is multipart — scanning for base64 block");
  const normalized = body.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const base64Lines = [];
  let collecting = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    if (trimmedLine.startsWith("-")) {
      collecting = false;
      continue;
    }
    if (trimmedLine.includes(":")) {
      collecting = false;
      continue;
    }
    if (trimmedLine.startsWith("{")) {
      collecting = false;
      continue;
    }

    if (/^[A-Za-z0-9+/=]+$/.test(trimmedLine)) {
      collecting = true;
      base64Lines.push(trimmedLine);
    } else if (collecting) {
      break;
    }
  }

  if (base64Lines.length === 0) throw new Error("Could not find base64 content in multipart body");
  return base64Lines.join("");
}

/**
 * Extract JSON metadata from multipart body.
 */
function extractMetadataFromBody(body) {
  if (isRawBase64(body.trim())) {
    console.log("Raw base64 body — no metadata found, will build from item fields");
    return null;
  }

  const match = body.match(/\{[\s\S]*?\}/);
  if (!match) {
    console.log("No JSON metadata found in body — will build from item fields");
    return null;
  }

  try {
    const parsed = JSON.parse(match[0]);
    console.log("Extracted metadata from body:", parsed);
    return parsed;
  } catch (e) {
    console.log("Failed to parse metadata JSON:", e.message);
    return null;
  }
}

/**
 * Build a clean multipart/related body Buffer with binary file content.
 */
function buildMultipartBuffer(boundary, metadata, fileBuffer, mimeType = "application/octet-stream") {
  const metaPart =
    `--${boundary}\r\n` + `Content-Type: application/json; charset=UTF-8\r\n\r\n` + `${JSON.stringify(metadata)}\r\n`;

  const filePart = `--${boundary}\r\n` + `Content-Type: ${mimeType}\r\n\r\n`;

  const closing = `\r\n--${boundary}--`;

  return Buffer.concat([Buffer.from(metaPart), Buffer.from(filePart), fileBuffer, Buffer.from(closing)]);
}

/**
 * Main entry point — routes to Google Drive or OneDrive based on drive type.
 */

async function checkFileExistsOnDrive(checkData) {
  const { endpointurl, Headers } = checkData;
  // endpointurl is a plain string here (not an object like Exportdrive.endpointurl)
  const checkUrl = typeof endpointurl === "string" ? endpointurl : endpointurl.requesturl;

  const ALLOWED_HOSTS = ["www.googleapis.com", "graph.microsoft.com"];
  const parsedUrl = new URL(checkUrl);
  if (!ALLOWED_HOSTS.includes(parsedUrl.hostname)) {
    throw new Error(`Blocked check request to unauthorized host: ${parsedUrl.hostname}`);
  }

  console.log("Checking if file already exists on Drive...");
  const response = await axios({
    method: "get",
    url: checkUrl,
    headers: { Authorization: Headers["Authorization"] },
  });

  const files = response.data.files || [];
  if (files.length === 0) {
    console.log("File not found on Drive — proceeding with upload.");
    return null;
  }

  console.log(`File already exists on Drive (${files.length} match). Skipping upload.`);
  const existing = files[0];

  // Fetch full metadata so we have webViewLink/webContentLink
  const metaResponse = await axios({
    method: "get",
    url: `https://www.googleapis.com/drive/v3/files/${existing.id}?fields=id,name,mimeType,webViewLink,webContentLink`,
    headers: { Authorization: Headers["Authorization"] },
  });

  return metaResponse.data;
  // Shape: { id, name, mimeType, webViewLink, webContentLink }
}
exports.uploadToDrive = async (exportdriveData, itemData = {}, checkExistingData = null) => {
  const { endpointurl, RequestMethod, Headers, body } = exportdriveData;
  const driveType = (exportdriveData["Drive type"] || "").toLowerCase();
  const requestUrl = endpointurl.requesturl;
  const method = RequestMethod.toLowerCase();

  const ALLOWED_HOSTS = ["www.googleapis.com", "graph.microsoft.com"];
  const parsedUrl = new URL(requestUrl);
  if (!ALLOWED_HOSTS.includes(parsedUrl.hostname)) {
    throw new Error(`Blocked request to unauthorized host: ${parsedUrl.hostname}`);
  }

  if (checkExistingData) {
    const existingFile = await checkFileExistsOnDrive(checkExistingData);
    if (existingFile) {
      return existingFile; // return existing metadata, no upload
    }
  }

  // ── Step 1: Extract base64 and convert to binary Buffer ──
  const base64String = extractBase64FromBody(body);
  const fileBuffer = Buffer.from(base64String, "base64");
  // ── Step 2: Extract or build metadata ──
  let metadata = extractMetadataFromBody(body);
  if (!metadata) {
    metadata = { name: itemData.name || "unknown_file" };
    console.log("Built metadata from item fields:", metadata);
  }

  // ── Step 3: Route to correct drive ──
  // if (driveType === 'google drive') {
  //   return uploadToGoogleDrive(requestUrl, method, Headers, metadata, fileBuffer);
  // } else if (driveType === 'one drive' || driveType === 'onedrive') {
  //   return uploadToOneDrive(requestUrl, method, Headers, fileBuffer, metadata);
  // }

  if (driveType === "google drive") {
    return uploadToGoogleDrive(requestUrl, method, Headers, metadata, fileBuffer);
  } else if (driveType === "one drive" || driveType === "onedrive") {
    // ── Fix: Inject file extension into OneDrive URL if missing ──
    let finalUrl = requestUrl;
    const fileExt = getExtensionFromType(itemData.filetype || itemData.name);
    if (fileExt && requestUrl.includes(":/content")) {
      // URL pattern: .../filename:/content → .../filename.ext:/content
      const beforeContent = requestUrl.split(":/content")[0];
      if (!beforeContent.toLowerCase().endsWith(fileExt)) {
        finalUrl = beforeContent + fileExt + ":/content";
      }
    }
    return uploadToOneDrive(finalUrl, method, Headers, fileBuffer, metadata);
  }

  throw new Error(`Unsupported drive type: "${driveType}". Expected "google drive" or "one drive"`);
};

/**
 * Upload binary file to Google Drive using multipart upload.
 * After upload, fetches webViewLink + webContentLink via a second GET call.
 */
async function uploadToGoogleDrive(url, method, headers, metadata, fileBuffer) {
  const boundary = `boundary_${Date.now()}`;
  const bodyBuffer = buildMultipartBuffer(boundary, metadata, fileBuffer);

  console.log("Uploading to Google Drive...");
  console.log("Metadata being sent:", metadata);
  console.log("Multipart body size:", bodyBuffer.length, "bytes");

  // ── Step 1: Upload the file ──
  const uploadResponse = await axios({
    method,
    url,
    headers: {
      Authorization: headers["Authorization"],
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    data: bodyBuffer,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const fileId = uploadResponse.data.id;
  console.log("Google Drive upload success. File ID:", fileId);

  // ── Step 2: Make file public (anyone with the link can view, no login needed) ──
  await axios({
    method: "post",
    url: `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
    headers: {
      Authorization: headers["Authorization"],
      "Content-Type": "application/json",
    },
    data: {
      role: "reader", // read-only access
      type: "anyone", // no Google account required
    },
  });
  console.log("File permission set to public (anyone with link).");

  // ── Step 3: Fetch webViewLink (now accessible without login) ──
  const metaResponse = await axios({
    method: "get",
    url: `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,webViewLink,webContentLink`,
    headers: {
      Authorization: headers["Authorization"],
    },
  });

  console.log("Google Drive file metadata:", metaResponse.data);

  return {
    ...uploadResponse.data,
    ...metaResponse.data,
  };
  // Final shape: { id, name, mimeType, webViewLink, webContentLink }
  // webViewLink  → opens file in browser, no login needed ✅
  // webContentLink → direct download, no login needed ✅
}

/**
 * Upload binary file directly to OneDrive.
 * OneDrive returns the download URL directly in the upload response.
 */
async function uploadToOneDrive(url, method, headers, fileBuffer, metadata) {
  console.log("Uploading to OneDrive...");
  console.log("File buffer size:", fileBuffer.length, "bytes");

  // ── Fix: Derive MIME type from filename ──
  const mimeType = getMimeType(metadata.name) || "application/octet-stream";

  const response = await axios({
    method,
    url,
    headers: {
      Authorization: headers["Authorization"],
      "Content-Type": mimeType,
    },
    data: fileBuffer,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  console.log("OneDrive upload success:", response.data);
  return response.data;
}
