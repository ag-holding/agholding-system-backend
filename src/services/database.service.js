const { db } = require('../config/database');
const logger = require('../utils/logger');

const DECIMAL_PRECISION = 18;
const DECIMAL_SCALE = 2;

const parseColumnLength = (col) => {
  if (!col.length) return { length: null, precision: null, scale: null };
  const type = col.type.toLowerCase();
  if (['decimal', 'numeric', 'float', 'double', 'number'].includes(type)) {
    return { length: DECIMAL_PRECISION, precision: DECIMAL_PRECISION, scale: DECIMAL_SCALE };
  }
  return { length: parseInt(col.length), precision: null, scale: null };
};

/**
 * createTableWithColumns
 * Single-tenant version: uses the shared `db` connection directly.
 * The `accountId` parameter has been removed.
 */
const createTableWithColumns = async (tableName, columns, primary_key, foreign_key) => {
  try {
    const tableExists = await db.schema.hasTable(tableName);

    if (tableExists) {
      logger.info(`Table ${tableName} already exists. Checking for new columns...`);

      const existingDbColumns = await db(tableName).columnInfo();
      const existingDbColumnNames = Object.keys(existingDbColumns).map((n) => n.toLowerCase());

      const existingMetadata = await db('table_metadata')
        .where({ table_name: tableName })
        .select('column_name', 'column_type', 'column_length');

      const metadataMap = new Map(
        existingMetadata.map((col) => [
          col.column_name.toLowerCase(),
          { type: col.column_type, length: col.column_length },
        ])
      );

      const newColumns = [];
      const duplicateColumns = [];
      const conflictingColumns = [];

      for (const col of columns) {
        const colLower = col.name.toLowerCase();
        if (existingDbColumnNames.includes(colLower)) {
          const meta = metadataMap.get(colLower);
          if (meta) {
            const { length: incomingLength } = parseColumnLength(col);
            const typeMatches = meta.type.toLowerCase() === col.type.toLowerCase();
            const lengthMatches = meta.length === incomingLength;
            if (typeMatches && lengthMatches) {
              duplicateColumns.push({ name: col.name, reason: 'Column already exists with same definition' });
            } else {
              conflictingColumns.push({
                name: col.name,
                existing: `${meta.type}(${meta.length})`,
                requested: `${col.type}(${incomingLength})`,
                reason: 'Column exists with different type/length',
              });
            }
          } else {
            duplicateColumns.push({ name: col.name, reason: 'Column exists in DB but missing in metadata' });
          }
        } else {
          newColumns.push(col);
        }
      }

      if (newColumns.length === 0) {
        return { exists: true, updated: false, skippedReason: 'All columns were duplicates', duplicateColumns };
      }

      await db.schema.alterTable(tableName, (table) => {
        newColumns.forEach((col) => {
          const column = buildColumn(table, col);
          if (column) {
            column.nullable();
            if (col.name === 'unique_key') column.unique();
          }
        });
      });

      return { exists: true, updated: true, addedColumns: newColumns, duplicateColumns, conflictingColumns };
    }

    // Table does not exist — create it
    await db.schema.createTable(tableName, (table) => {
      let primaryKeyAdded = false;
      if (primary_key) {
        const pkColumn = columns.find((c) => c.name === primary_key);
        if (pkColumn) {
          switch (pkColumn.type?.toLowerCase()) {
            case 'integer': case 'int': table.integer(primary_key).primary(); break;
            case 'biginteger': case 'bigint': table.bigInteger(primary_key).primary(); break;
            case 'string': case 'varchar': table.string(primary_key, pkColumn.length || 255).primary(); break;
            default: table.text(primary_key).primary();
          }
          primaryKeyAdded = true;
        }
      }

      columns.forEach((col) => {
        if (primaryKeyAdded && col.name === primary_key) return;
        const column = buildColumn(table, col);
        if (column) {
          if (col.name === 'unique_key') column.unique();
          if (col.name === primary_key && !primaryKeyAdded) column.primary();
        }
      });

      if (Array.isArray(foreign_key)) {
        foreign_key.forEach((fk) => {
          if (fk.column_name && fk.tableRef && fk.primary_key) {
            table.foreign(fk.column_name).references(fk.primary_key).inTable(fk.tableRef)
              .onDelete(fk.onDelete || 'CASCADE').onUpdate(fk.onUpdate || 'CASCADE');
          }
        });
      }

      table.timestamps(true, true);
      table.string('sync_batch_id', 100).nullable();
    });

    return { exists: false, created: true };
  } catch (error) {
    logger.error(`Error in createTableWithColumns: ${error.message}`);
    throw new Error(`Failed to create/update table: ${error.message}`);
  }
};

function buildColumn(table, col) {
  const { name, type, length } = col;
  switch (type?.toLowerCase()) {
    case 'string': case 'varchar':
      return !length || length >= 1000 ? table.text(name) : table.string(name, length);
    case 'inlinehtml': case 'longvarchar': case 'richtext': case 'textarea':
    case 'text': case 'currency2': case 'select': case 'currency':
      return table.text(name);
    case 'float': case 'double': case 'number':
      return table.decimal(name, DECIMAL_PRECISION, DECIMAL_SCALE);
    case 'integer': case 'int': return table.integer(name);
    case 'biginteger': case 'bigint': return table.bigInteger(name);
    case 'decimal': case 'numeric':
      return table.decimal(name, DECIMAL_PRECISION, DECIMAL_SCALE);
    case 'boolean': case 'bool': return table.boolean(name);
    case 'date': return table.text(name);
    case 'datetime': case 'timestamp': return table.timestamp(name);
    case 'time': return table.time(name);
    case 'json': case 'jsonb': return table.jsonb(name);
    case 'uuid': return table.uuid(name);
    default: return table.text(name);
  }
}

/**
 * insertBatchData
 * Single-tenant version: no accountId, uses shared `db`.
 */
const insertBatchData = async (tableName, data, batchId, uniqueKey) => {
  try {
    const columnsMetadata = await db('table_metadata')
      .where({ table_name: tableName })
      .select('column_name', 'column_type');

    const validColumns = columnsMetadata.map((c) => c.column_name);
    const numericColumns = columnsMetadata
      .filter((c) =>
        ['real','float','double','integer','int','biginteger','bigint','decimal','numeric','number']
          .includes(c.column_type.toLowerCase())
      )
      .map((c) => c.column_name);
    const dateColumns = columnsMetadata
      .filter((c) => ['date','datetime','timestamp','time'].includes(c.column_type.toLowerCase()))
      .map((c) => c.column_name);

    const records = data.map((record) => {
      const out = {};
      validColumns.forEach((col) => {
        let value = record.hasOwnProperty(col) ? record[col] : null;
        if ((numericColumns.includes(col) || dateColumns.includes(col)) && (value === '' || value == null)) {
          value = null;
        }
        if (value === '') value = null;
        out[col] = value;
      });
      out.sync_batch_id = batchId;
      return out;
    });

    if (uniqueKey && !validColumns.includes(uniqueKey)) {
      throw new Error(`Invalid unique key: '${uniqueKey}' not found in table columns`);
    }

    const chunkSize = 1000;
    let totalProcessed = 0;

    for (let i = 0; i < records.length; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize);
      if (uniqueKey) {
        const updateCols = Object.keys(chunk[0]).filter((c) => c !== uniqueKey);
        await db(tableName).insert(chunk).onConflict(uniqueKey).merge(updateCols);
      } else {
        await db(tableName).insert(chunk);
      }
      totalProcessed += chunk.length;
    }

    return { processed: totalProcessed, upserted: !!uniqueKey };
  } catch (error) {
    logger.error(`Error in insertBatchData for ${tableName}: ${error.message}`);
    throw error;
  }
};

module.exports = {
  createTableWithColumns,
  insertBatchData,
};
