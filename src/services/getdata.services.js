const { db } = require('../config/database');

const tableListCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const SYSTEM_TABLES = new Set([
  'table_metadata',
  'table_relationships',
  'app_users',
  'user_permissions',
  'invitation_tokens',
]);

/**
 * listClientTables
 * Single-tenant: queries information_schema directly on the single `db`.
 * If `allowedModules` is provided (non-admin users), only returns those tables.
 */
async function listClientTables(allowedModules = null) {
  const result = await db
    .select('table_name')
    .from('information_schema.tables')
    .where({ table_schema: 'public', table_type: 'BASE TABLE' });

  let tables = result
    .map((r) => r.table_name)
    .filter((t) => !SYSTEM_TABLES.has(t))
    .sort((a, b) => a.localeCompare(b));

  // If the user has restricted module access, filter to only allowed tables
  if (allowedModules !== null && Array.isArray(allowedModules)) {
    const allowedSet = new Set(allowedModules.map((m) => m.toLowerCase()));
    tables = tables.filter((t) => allowedSet.has(t.toLowerCase()));
  }

  return tables;
}

/**
 * getClientTableRows
 * Fetches paginated rows from a table.
 *
 * @param {string}   tableName
 * @param {object}   options      { page, pageSize, filters }
 * @param {function} subsidiaryFn  req.applySubsidiaryFilter – injected by middleware
 * @param {string[]|null} allowedModules  null = admin (all tables)
 * @param {function} hasSubColumnFn  req.hasSubsidiaryColumn - to check column existence
 */
async function getClientTableRows(tableName, options = {}, subsidiaryFn = null, allowedModules = null, hasSubColumnFn = null) {
  if (!tableName) throw new Error('tableName is required');

  const { page = 1, pageSize = 10, filters = [] } = options;

  // Validate table exists & is allowed
  const cacheKey = 'tables_list';
  let tableNames;
  if (tableListCache.has(cacheKey) && Date.now() - tableListCache.get(cacheKey).timestamp < CACHE_TTL) {
    tableNames = tableListCache.get(cacheKey).tables;
  } else {
    const rows = await db.select('table_name').from('information_schema.tables')
      .where({ table_schema: 'public', table_type: 'BASE TABLE' });
    tableNames = rows.map((r) => r.table_name).filter((t) => !SYSTEM_TABLES.has(t));
    tableListCache.set(cacheKey, { tables: tableNames, timestamp: Date.now() });
  }

  if (!tableNames.includes(tableName)) {
    throw new Error('Invalid or inaccessible table name');
  }

  // Check module-level access
  if (allowedModules !== null && Array.isArray(allowedModules)) {
    const allowedSet = new Set(allowedModules.map((m) => m.toLowerCase()));
    if (!allowedSet.has(tableName.toLowerCase())) {
      throw Object.assign(new Error(`Access denied to module "${tableName}"`), { statusCode: 403 });
    }
  }

  // Build base query
  let baseQuery = db(tableName);

  // Apply subsidiary filter (injected by permission middleware)
  if (subsidiaryFn) {
    // Check if table has subsidiary column before applying filter
    const hasSubColumn = hasSubColumnFn ? await hasSubColumnFn(tableName) : true;
    if (hasSubColumn) {
      baseQuery = subsidiaryFn(baseQuery, tableName);
    }
  }

  // Apply user-supplied column filters
  filters.forEach((filter) => {
    if (filter.column && filter.value !== undefined && filter.value !== null) {
      baseQuery = baseQuery.where(filter.column, 'ILIKE', `%${filter.value}%`);
    }
  });

  const [{ count }] = await baseQuery.clone().count('* as count');
  const totalRows = parseInt(count, 10);

  const offset = (page - 1) * pageSize;
  const rows = await baseQuery.clone().select('*').limit(pageSize).offset(offset);

  let columns = [];
  if (rows.length > 0) {
    columns = Object.keys(rows[0]);
  } else {
    const cols = await db.select('column_name').from('information_schema.columns')
      .where({ table_schema: 'public', table_name: tableName });
    columns = cols.map((c) => c.column_name);
  }

  const filteredColumns = columns.filter((col) => !col.toLowerCase().includes('foreign_key'));
  const filteredRows = rows.map((row) => {
    const out = {};
    filteredColumns.forEach((col) => { out[col] = row[col]; });
    return out;
  });

  return {
    columns: filteredColumns,
    rows: filteredRows,
    pagination: {
      currentPage: page,
      pageSize,
      totalRows,
      totalPages: Math.ceil(totalRows / pageSize),
    },
  };
}

async function getChildTables(parentTableName) {
  if (!parentTableName) throw new Error('parentTableName is required');
  return db('table_relationships')
    .where({ parent_table: parentTableName })
    .select('child_table', 'foreign_key_column', 'parent_key_column', 'relationship_name');
}

async function getChildRecords(parentTableName, parentRecordId, childTableName, subsidiaryFn = null, hasSubColumnFn = null) {
  if (!parentTableName || !parentRecordId || !childTableName) {
    throw new Error('All parameters are required');
  }

  const relationship = await db('table_relationships')
    .where({ parent_table: parentTableName, child_table: childTableName })
    .first();

  if (!relationship) {
    throw new Error(`No relationship found between ${parentTableName} and ${childTableName}`);
  }

  let query = db(childTableName).where(relationship.foreign_key_column, parentRecordId);
  if (subsidiaryFn) {
    const hasSubColumn = hasSubColumnFn ? await hasSubColumnFn(childTableName) : true;
    if (hasSubColumn) {
      query = subsidiaryFn(query, childTableName);
    }
  }

  const childRecords = await query.select('*');

  let columns = [];
  if (childRecords.length > 0) {
    columns = Object.keys(childRecords[0]);
  } else {
    const cols = await db.select('column_name').from('information_schema.columns')
      .where({ table_schema: 'public', table_name: childTableName });
    columns = cols.map((c) => c.column_name);
  }

  const filteredColumns = columns.filter((col) => !col.toLowerCase().includes('foreign_key'));
  const filteredRecords = childRecords.map((record) => {
    const out = {};
    filteredColumns.forEach((col) => { out[col] = record[col]; });
    return out;
  });

  return {
    childTable: childTableName,
    columns: filteredColumns,
    records: filteredRecords,
    totalRecords: filteredRecords.length,
  };
}

async function getAllChildRecords(parentTableName, parentRecordId, subsidiaryFn = null, hasSubColumnFn = null) {
  if (!parentTableName || !parentRecordId) {
    throw new Error('parentTableName and parentRecordId are required');
  }

  const childTables = await getChildTables(parentTableName);

  const childData = await Promise.all(
    childTables.map(async (rel) => {
      let query = db(rel.child_table).where(rel.foreign_key_column, parentRecordId);
      if (subsidiaryFn) {
        const hasSubColumn = hasSubColumnFn ? await hasSubColumnFn(rel.child_table) : true;
        if (hasSubColumn) {
          query = subsidiaryFn(query, rel.child_table);
        }
      }
      const records = await query.select('*');

      let columns = [];
      if (records.length > 0) {
        columns = Object.keys(records[0]);
      } else {
        const cols = await db.select('column_name').from('information_schema.columns')
          .where({ table_schema: 'public', table_name: rel.child_table });
        columns = cols.map((c) => c.column_name);
      }

      const filteredColumns = columns.filter((col) => !col.toLowerCase().includes('foreign_key'));
      const filteredRecords = records.map((r) => {
        const out = {};
        filteredColumns.forEach((col) => { out[col] = r[col]; });
        return out;
      });

      return {
        childTable: rel.child_table,
        relationshipName: rel.relationship_name || rel.child_table,
        columns: filteredColumns,
        records: filteredRecords,
        totalRecords: filteredRecords.length,
      };
    })
  );

  return { parentTable: parentTableName, parentRecordId, childTables: childData };
}

module.exports = {
  listClientTables,
  getClientTableRows,
  getChildTables,
  getChildRecords,
  getAllChildRecords,
};
