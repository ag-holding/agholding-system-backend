const { getClientConnection } = require("../services/database.service");
const { uploadToDrive } = require("../services/drive.service");

exports.uploadFiles = async (req, res) => {
  try {
    const { accountId, uniqueKey, data } = req.body;
    console.log("Received upload request for accountId:", accountId, "with", data.length, "files");

    if (!accountId || !Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ success: false, error: "accountId and data array are required" });
    }

    const clientDb = await getClientConnection(accountId);
    const results = [];

    for (const item of data) {
      const exportdrive = item.exportdrive?.Exportdrive;
      if (!exportdrive) {
        results.push({ unique_key: item.unique_key, error: "No exportdrive data found" });
        continue;
      }
      

      // Upload to Google Drive / OneDrive using the provided endpoint details
      const checkExistingFiles = item.exportdrive?.CheckexistingFiles || null;
      const driveResponse = await uploadToDrive(exportdrive, item, checkExistingFiles);

      // Build the exportdrive JSON to store in the exportdrive column
      const exportdriveRecord = {
        driveFileId: driveResponse.id,
        driveType: exportdrive["Drive type"],
        driveUrl:
          driveResponse.webViewLink ||
          driveResponse.webContentLink ||
          driveResponse["@microsoft.graph.downloadUrl"] ||
          null,
        mimeType: driveResponse.mimeType || null,
        driveName: driveResponse.name || null,
      };
      const downloadableUrl =
        driveResponse.webViewLink || // Google Drive ✅ no login needed
        driveResponse["@microsoft.graph.downloadUrl"] || // OneDrive ✅
        driveResponse.webContentLink || // fallback
        null;

      // Map to actual file table columns
      const fileRecord = {
        unique_key: item.unique_key,
        internalid: item.internalid,
        name: item.name,
        folder: item.folder,
        folder_path: item.folder_path || null,
        filetype: item.filetype,
        documentsize: item.documentsize,
        isavailable: item.isavailable,
        availablewithoutlogin: item.availablewithoutlogin,
        companywideusage: item.companywideusage,
        created: item.created,
        description: item.description || null,
        externalid: item.externalid || null,
        hostedpath: downloadableUrl || null,
        modified: item.modified,
        owner: item.owner,
        url: item.url,
        exportdrive: JSON.stringify(exportdriveRecord),
      };

      // ── Upsert: insert if not exists, update if unique_key already exists ──
      await clientDb("file")
        .insert(fileRecord)
        .onConflict("unique_key") // conflict on primary key
        .merge([
          // columns to UPDATE when conflict occurs
          "internalid",
          "name",
          "folder",
          "folder_path",
          "filetype",
          "documentsize",
          "isavailable",
          "availablewithoutlogin",
          "companywideusage",
          "created",
          "description",
          "externalid",
          "hostedpath",
          "modified",
          "owner",
          "url",
          "exportdrive", // ← always update with latest drive response
        ]);

      console.log("Upserted file record for unique_key:", item.unique_key);

      results.push({
        unique_key: item.unique_key,
        success: true,
        drive_file_id: driveResponse.id,
        drive_url: exportdriveRecord.driveUrl,
      });
    }

    res.status(200).json({ success: true, results });
  } catch (error) {
    console.error("Upload error:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data || null,
      status: error.response?.status || null,
    });
  }
};
