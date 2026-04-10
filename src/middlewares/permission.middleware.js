const { db } = require('../config/database');

/**
 * loadUserPermissions
 * ───────────────────
 * Must run AFTER verifyToken.
 *
 * Loads permissions from the user's assigned role (app_roles).
 * Admin system role → full access bypass.
 * Non-admin → subsidiary_access + module_access from app_roles.
 *
 *   req.permissions = {
 *     subsidiaryAccess : ['Sub A', 'Sub B'],   // [] = none, null = all (Admin)
 *     moduleAccess     : ['customers', 'invoices'],  // [] = none, null = all (Admin)
 *     isAdmin          : false,
 *     roleName         : 'Finance User',
 *   }
 */
exports.loadUserPermissions = async (req, res, next) => {
  try {
    // Fast-path: if the JWT says Admin, grant full access immediately
    if (req.user.role === 'Admin') {
      req.permissions = { subsidiaryAccess: null, moduleAccess: null, isAdmin: true, roleName: 'Admin' };
      return next();
    }

    // Load the user's assigned role
    const user = await db('app_users')
      .select('app_users.role_id', 'app_roles.name as role_name',
              'app_roles.subsidiary_access', 'app_roles.module_access',
              'app_roles.is_system')
      .leftJoin('app_roles', 'app_users.role_id', 'app_roles.id')
      .where('app_users.id', req.user.userId)
      .first();

    // If somehow this user's role is a system Admin role (double-check)
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
      subsidiaryAccess: user?.subsidiary_access != null ? parseJsonb(user.subsidiary_access) : [],
      moduleAccess: user?.module_access != null ? parseJsonb(user.module_access) : [],
      isAdmin: false,
      roleName: user?.role_name ?? 'Unknown',
    };

    next();
  } catch (err) {
    next(err);
  }
};

/**
 * checkModuleAccess
 * ─────────────────
 * Must run AFTER loadUserPermissions.
 * Blocks 403 if the requested table is not in the user's module_access.
 */
exports.checkModuleAccess = (req, res, next) => {
  if (req.permissions.isAdmin) return next();

  const requestedTable = req.params.tableName || req.params.parentTable || req.params.childTable;
  if (!requestedTable) return next();

  const allowedModules = req.permissions.moduleAccess;
  const hasAccess = allowedModules.some(
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
 * subsidiaryFilter
 * ────────────────
 * Attaches req.hasSubsidiaryColumn and req.applySubsidiaryFilter helpers.
 */
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
