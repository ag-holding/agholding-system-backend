const { tableCreationQueue, dataInsertionQueue } = require("../queues/queue.config");
const { db } = require("../config/database");
const logger = require("../utils/logger");
const { createTableWithColumns, getClientConnection } = require("../services/database.service");
const { insertBatchData } = require("../services/database.service");

function splitColumnName(value) {
  // Match: name(label)
  // const match = value.match(/^([^\(]+)\((.+)\)$/);
  // if (match) {
  //   return { name: match[1].trim(), label: match[2].trim() };
  const firstParen = value.indexOf("(");
  const lastParen = value.lastIndexOf(")");
  if (firstParen !== -1 && lastParen !== -1 && lastParen > firstParen) {
    return {
      name: value.slice(0, firstParen).trim(),
      label: value.slice(firstParen + 1, lastParen).trim(),
    };
  }
  return { name: value.trim(), label: null };
}
exports.receiveTables = async (req, res, next) => {
  try {
    const { accountId, tables } = req.body;

    if (!accountId || !Array.isArray(tables)) {
      return res.status(400).json({
        success: false,
        error: "accountId and tables array are required",
      });
    }

    // ✅ VERIFY CLIENT DATABASE EXISTS
    const client = await db("clients").where({ account_id: accountId }).first();

    if (!client) {
      return res.status(404).json({
        success: false,
        error: `Client '${accountId}' not found.`,
      });
    }

    logger.info(`Registering tables for client ${accountId} in database ${client.database_name}`);

    // Register each table in sync_status
    for (const tableName of tables) {
      await db("sync_status")
        .insert({
          account_id: accountId,
          table_name: tableName,
          status: "pending",
          total_records: 0,
          synced_records: 0,
        })
        .onConflict(["account_id", "table_name"])
        .ignore();
    }

    res.status(200).json({
      success: true,
      message: `Registered ${tables.length} tables for client ${accountId}`,
      database: client.database_name,
      tables,
    });
  } catch (error) {
    next(error);
  }
};

exports.receiveColumns = async (req, res, next) => {
  try {
    const { tableName } = req.params;
    const { accountId, columns, primary_key, foreign_key } = req.body;
    console.log("Received columns:", { accountId, tableName, columns, primary_key, foreign_key });
    //  i want to log of primary_key and foreign_key
    logger.info(`Received columns for ${tableName}: ${columns.length} columns, primary key: ${primary_key}, foreign keys: ${Array.isArray(foreign_key) ? foreign_key.length : 0}`);


    // ✅ ENHANCED VALIDATION
    if (!accountId || !Array.isArray(columns) || columns.length === 0) {
      return res.status(400).json({
        success: false,
        error: "accountId and columns array are required",
      });
    }
    // ✅ VALIDATE EACH COLUMN STRUCTURE
    for (const col of columns) {
      if (!col.name || !col.type) {
        return res.status(400).json({
          success: false,
          error: 'Each column must have "name" and "type" properties',
          invalidColumn: col,
        });
      }

      // ✅ VALIDATE TYPE-SPECIFIC REQUIREMENTS
      if (["string", "varchar"].includes(col.type.toLowerCase())) {
        if (!col.length || col.length <= 0) {
          return res.status(400).json({
            success: false,
            error: `Column "${col.name}" of type "${col.type}" requires a valid "length" property`,
            hint: 'Example: { "name": "email", "type": "string", "length": 255 }',
          });
        }
      }
    }

    // ✅ VERIFY TABLE IS REGISTERED
    const tableStatus = await db("sync_status").where({ account_id: accountId, table_name: tableName }).first();
    if (!tableStatus) {
      return res.status(404).json({
        success: false,
        error: `Table '${tableName}' not registered for client '${accountId}'.`,
      });
    }

    const clientDb = await require("../services/database.service").getClientConnection(accountId);

    const foreignKeyMap = {};
    if (Array.isArray(foreign_key)) {
      foreign_key.forEach((fk) => {
        foreignKeyMap[fk.column_name] = {
          foreign_table: fk.tableRef,
          foreign_column: fk.primary_key,
        };
      });
    }

    // ✅ STORE COLUMN METADATA WITH LENGTH/PRECISION
    for (const col of columns) {
      const { name, type, length } = col;
      const parsed = splitColumnName(col.name);
      const columnName = parsed.name;
      const columnLabel = parsed.label;

      let columnLength = null;
      if (length) {
        if (["decimal", "numeric", "float", "double", "number"].includes(type.toLowerCase())) {
          columnLength = 18;
        } else {
          columnLength = parseInt(length);
        }
      }

      const fkInfo = foreignKeyMap[columnName] || {};
      await clientDb("table_metadata")
        .insert({
          table_name: tableName,
          column_name: columnName,
          label: columnLabel,
          column_type: type,
          column_length: columnLength || null,
          foreign_table: fkInfo.foreign_table || null,
          foreign_column: fkInfo.foreign_column || null,
        })
        .onConflict(["table_name", "column_name"])
        .merge({
          label: columnLabel,
          column_type: type,
          column_length: columnLength || null,
          foreign_table: fkInfo.foreign_table || null,
          foreign_column: fkInfo.foreign_column || null,
          updated_at: new Date(),
        });

      col.name = columnName;
    }

    // // ✅ NEW: Store parent-child relationships
    // if (Array.isArray(foreign_key)) {
    //   for (const fk of foreign_key) {
    //     if (fk.column_name && fk.tableRef && fk.primary_key) {
    //       await clientDb("table_relationships")
    //         .insert({
    //           parent_table: fk.tableRef,
    //           child_table: tableName,
    //           foreign_key_column: fk.column_name,
    //           parent_key_column: fk.primary_key,
    //           relationship_name: tableName,
    //         })
    //         .onConflict(["parent_table", "child_table", "foreign_key_column"])
    //         .merge({
    //           parent_key_column: fk.primary_key,
    //           relationship_name: tableName,
    //           updated_at: new Date(),
    //         });
    //     }
    //   }
    // }

      if (Array.isArray(foreign_key) && foreign_key.length > 0) {
      logger.info(`Processing ${foreign_key.length} foreign key relationships for ${tableName}`);
      
      for (const fk of foreign_key) {
        // Log each foreign key object for debugging
        logger.info(`Processing FK:`, JSON.stringify(fk));
        
        if (fk.column_name && fk.tableRef && fk.primary_key) {
          try {
            await clientDb("table_relationships")
              .insert({
                parent_table: fk.tableRef,
                child_table: tableName,
                foreign_key_column: fk.column_name,
                parent_key_column: fk.primary_key,
                relationship_name: `${fk.tableRef}_${tableName}_fk`,
              })
              .onConflict(["parent_table", "child_table", "foreign_key_column"])
              .merge({
                parent_key_column: fk.primary_key,
                relationship_name: `${fk.tableRef}_${tableName}_fk`,
                updated_at: new Date(),
              });
            
            logger.info(`✅ Stored relationship: ${fk.tableRef}.${fk.primary_key} -> ${tableName}.${fk.column_name}`);
          } catch (error) {
            logger.error(`❌ Failed to store relationship for ${tableName}.${fk.column_name}: ${error.message}`);
          }
        } else {
          logger.warn(`⚠️ Incomplete FK data:`, { column_name: fk.column_name, tableRef: fk.tableRef, primary_key: fk.primary_key });
        }
      }
    } else {
      logger.info(`No foreign keys provided for ${tableName}`);
    }
    // ✅ ADD JOB TO QUEUE TO CREATE TABLE
    // const job = await tableCreationQueue.add('create-table', {
    //   accountId,
    //   tableName,
    //   columns,
    //   database: client.database_name
    // });

    // logger.info(`✅ Table creation job queued: ${job.id}`);

    // ✅ UPDATE SYNC STATUS TO SCHEMA_DEFINED
    // await db('sync_status')
    //   .where({  account_id: accountId, table_name: tableName })
    //   .update({
    //     status: 'schema_defined',
    //     updated_at: new Date()
    //   });

    try {
      const result = await createTableWithColumns(accountId, tableName, columns, primary_key, foreign_key);

      if (result.exists) {
        logger.info(`Table ${clientDb.client.config.connection.database}.${tableName} already exists`);
      } else {
        logger.info(`✅ Table ${clientDb.client.config.connection.database}.${tableName} created successfully`);
      }

      // ✅ UPDATE SYNC STATUS TO COMPLETED
      await db("sync_status").where({ account_id: accountId, table_name: tableName }).update({
        status: "completed",
        updated_at: new Date(),
      });
    } catch (error) {
      await db("sync_status").where({ account_id: accountId, table_name: tableName }).update({
        status: "failed",
        error_message: error.message,
        updated_at: new Date(),
      });

      throw error;
    }

    res.status(200).json({
      success: true,
      message: `Schema defined for table '${tableName}'. Table creation in progress.`,
      database: clientDb.client.config.connection.database,
      table: tableName,
      columns: columns.length,
      // jobId: job.id,
      nextStep: {
        step: 4,
        endpoint: `/api/netsuite/webhook/data/${tableName}`,
        description: "Insert data into the table",
        example: {
          accountId: accountId,
          batchId: "batch_001",
          data: [{ name: "John Doe", email: "john@example.com" }],
        },
      },
    });
  } catch (error) {
    logger.error(`Error in receiveColumns: ${error.message}`);
    next(error);
  }
};

exports.receiveData = async (req, res, next) => {
  try {
    const { tableName } = req.params;
    const { accountId, batchId, data, uniqueKey } = req.body;
    const clientDb = await getClientConnection(accountId);

    if (!accountId || !Array.isArray(data) || data.length === 0) {
      return res.status(400).json({
        success: false,
        error: "accountId and data array are required",
      });
    }

    // ✅ VERIFY TABLE SCHEMA IS DEFINED
    const tableStatus = await db("sync_status").where({ account_id: accountId, table_name: tableName }).first();

    if (!tableStatus) {
      return res.status(404).json({
        success: false,
        error: `Table '${tableName}' not found for client '${accountId}'`,
      });
    }

    if (tableStatus.status === "pending") {
      return res.status(400).json({
        success: false,
        error: `Table schema not defined`,
      });
    }

    // ✅ GET COLUMN METADATA FOR VALIDATION
    const columns = await clientDb("table_metadata")
      .where({ table_name: tableName })
      .select("column_name", "column_type");

    if (columns.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No columns defined for this table",
      });
    }

    // ✅ VALIDATE DATA STRUCTURE
    const columnNames = columns.map((c) => c.column_name);
    const dataKeys = Object.keys(data[0] || {});
    const invalidKeys = dataKeys.filter((key) => !columnNames.includes(key));

    if (invalidKeys.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Invalid columns: ${invalidKeys.join(", ")}`,
        validColumns: columnNames,
      });
    }

    // ✅ GET DATABASE NAME
    const client = await db("clients").where({ account_id: accountId }).first();

    // logger.info(`Inserting ${data.length} records into ${client.database_name}.${tableName}`);

    // ✅ ADD JOB TO INSERT DATA
    // const job = await dataInsertionQueue.add('insert-data', {
    //   accountId,
    //   tableName,
    //   data,
    //   batchId: batchId || `batch_${Date.now()}`,
    //   database: client.database_name
    // });

    // Update sync status
    // await db("sync_status")
    //   .where({ account_id: accountId, table_name: tableName })
    //   .update({
    //     status: "in_progress",
    //     total_records: db.raw("total_records + ?", [data.length]),
    //     updated_at: new Date(),
    //   });

    try {
      const result = await insertBatchData(accountId, tableName, data, batchId, uniqueKey);
      const insertedCount = typeof result.inserted === "number" ? result.inserted : result.processed || data.length;

      // logger.info(`✅ Inserted ${result.inserted} records into ${client.database_name}.${tableName}`);

      // ✅ UPDATE SYNC STATUS
      await db("sync_status")
        .where({ account_id: accountId, table_name: tableName })
        .update({
          synced_records: db.raw("synced_records + ?", [insertedCount]),
          last_sync_at: new Date(),
          status: "completed",
          updated_at: new Date(),
        });

      // logger.info(`✅ Sync status updated for ${tableName}`);
    } catch (error) {
      if (error.code === "23503") {
        return res.status(400).json({
          success: false,
          error: "Foreign key constraint failed",
          detail: error.detail,
        });
      }

      // logger.error(`Failed to insert data into ${tableName}: ${error.message}`);
      await db("sync_status").where({ account_id: accountId, table_name: tableName }).update({
        status: "failed",
        error_message: error.message,
        updated_at: new Date(),
      });

      throw error;
    }

    res.status(200).json({
      success: true,
      message: `Queued ${data.length} records for insertion`,
      database: client.database_name,
      table: tableName,
      // jobId: job.id,
      batchId: batchId || `batch_${Date.now()}`,
    });
  } catch (error) {
    next(error);
  }
};
