const { db } = require('../config/database');

exports.loadUserPermissions = async (req, res, next) => {
  try {
    if (req.user.role === 'Admin') {
      req.permissions = { subsidiaryAccess: null, moduleAccess: null, isAdmin: true, roleName: 'Admin' };
      return next();
    }

    const user = await db('app_users')
      .select('app_users.role_id', 'app_roles.name as role_name',
              'app_roles.subsidiary_access', 'app_roles.module_access',
              'app_roles.is_system')
      .leftJoin('app_roles', 'app_users.role_id', 'app_roles.id')
      .where('app_users.id', req.user.userId)
      .first();

    if (user?.is_system) {
      req.permissions = { subsidiaryAccess: null, moduleAccess: null, isAdmin: true, roleName: user.role_name };
      return next();
    }

    const parseJsonb = (val) => {
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') { try { return JSON.parse(val); } catch { return []; } }
      return val ?? [];
    };

    req.permissions = {
      subsidiaryAccess: parseJsonb(user?.subsidiary_access),
      moduleAccess: parseJsonb(user?.module_access),
      isAdmin: false,
      roleName: user?.role_name ?? 'Unknown',
    };

    next();
  } catch (err) {
    next(err);
  }
};

exports.checkModuleAccess = (req, res, next) => {
  if (req.permissions.isAdmin) return next();

  const requestedTable = req.params.tableName || req.params.parentTable || req.params.childTable;
  if (!requestedTable) return next();

  const hasAccess = req.permissions.moduleAccess.some(
    (m) => m.toLowerCase() === requestedTable.toLowerCase()
  );

  if (!hasAccess) {
    return res.status(403).json({
      success: false,
      error: `Access denied: you do not have permission to access module "${requestedTable}"`,
    });
  }
  next();
};

/**
 * requireModuleAccess(moduleName)
 * ─────────────────────────────────
 * Factory that returns a middleware checking for a specific static module name.
 * Use this for report routes where there is no :tableName param.
 *
 * Example:
 *   router.get('/general-ledger',
 *     ...auth,
 *     requireModuleAccess('report_general_ledger'),
 *     ctrl.generalLedger
 *   );
 */
exports.requireModuleAccess = (moduleName) => (req, res, next) => {
  if (req.permissions.isAdmin) return next();

  const allowed = req.permissions.moduleAccess ?? [];
  const hasAccess = allowed.some((m) => m.toLowerCase() === moduleName.toLowerCase());

  if (!hasAccess) {
    return res.status(403).json({
      success: false,
      error: `Access denied: your role does not include access to "${moduleName}"`,
    });
  }
  next();
};

exports.subsidiaryFilter = (req, res, next) => {
  const SKIP_TABLES = new Set([
    'table_metadata', 'table_relationships',
    'app_users', 'app_roles', 'user_permissions',
    'invitation_tokens', 'subsidiary',
    'password_reset_tokens', 'password_reset_otps',
  ]);

  const tablesWithSubsidiary = new Map();

  req.hasSubsidiaryColumn = async (tableName) => {
    if (SKIP_TABLES.has(tableName?.toLowerCase())) return false;
    if (!tablesWithSubsidiary.has(tableName)) {
      try {
        const columns = await db(tableName).columnInfo();
        tablesWithSubsidiary.set(tableName, Object.keys(columns).some(c => c.toLowerCase() === 'subsidiary'));
      } catch {
        tablesWithSubsidiary.set(tableName, false);
      }
    }
    return tablesWithSubsidiary.get(tableName);
  };

  req.applySubsidiaryFilter = (query, tableName) => {
    if (req.permissions.isAdmin) return query;
    if (SKIP_TABLES.has(tableName?.toLowerCase())) return query;

    const subs = req.permissions.subsidiaryAccess;
    if (!subs || subs.length === 0) return query.whereRaw('1 = 0');

    const normalizedSubs = subs.map(s => s.trim().toLowerCase());
    return query.whereRaw(
      `LOWER(TRIM(subsidiary)) IN (${normalizedSubs.map(() => '?').join(',')})`,
      normalizedSubs
    );
  };

  next();
};
