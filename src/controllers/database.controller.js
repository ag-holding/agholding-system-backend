const { db } = require('../config/database');
const { listClientTables, getClientTableRows, getAllChildRecords, getChildTables, getChildRecords } = require('../services/getdata.services');
const logger = require('../utils/logger');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ─── Auth ───────────────────────────────────────────────────────────────────

/**
 * POST /database/auth/login
 * Authenticates against `app_users` in the single client database.
 */
exports.loginUser = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'email and password are required' });
    }

    const user = await db('app_users').where({ email }).first();
    if (!user || !user.password_hash) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    if (user.status !== 'Active') {
      return res.status(403).json({ success: false, error: 'Account is not active' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // Load permissions from the user's assigned role (app_roles)
    const role = user.role_id
      ? await db('app_roles').where({ id: user.role_id }).first()
      : null;

    const parseJsonb = (val) => {
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') { try { return JSON.parse(val); } catch { return []; } }
      return val ?? [];
    };

    const isAdmin = user.role === 'Admin' || role?.is_system;
    const subsidiaryAccess = isAdmin ? null : (role ? parseJsonb(role.subsidiary_access) : []);
    const moduleAccess = isAdmin ? null : (role ? parseJsonb(role.module_access) : []);

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    const cookieOpts = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/',
    };

    res.cookie('auth_token', token, cookieOpts);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        roleName: role?.name ?? user.role,
        subsidiaryAccess,
        moduleAccess,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.logoutUser = async (req, res, next) => {
  try {
    const cookieOpts = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
      path: '/',
    };
    res.clearCookie('auth_token', cookieOpts);
    res.status(200).json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    next(error);
  }
};

exports.checkAuth = async (req, res, next) => {
  try {
    // verifyToken middleware already validated the JWT — just return user info
    // Load permissions from the user's assigned role (app_roles)
    const userRow = await db('app_users').where({ id: req.user.userId }).first();
    const role = userRow?.role_id
      ? await db('app_roles').where({ id: userRow.role_id }).first()
      : null;

    const parseJsonb = (val) => {
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') { try { return JSON.parse(val); } catch { return []; } }
      return val ?? [];
    };

    const isAdmin = req.user.role === 'Admin' || role?.is_system;
    const subsidiaryAccess = isAdmin ? null : (role ? parseJsonb(role.subsidiary_access) : []);
    const moduleAccess = isAdmin ? null : (role ? parseJsonb(role.module_access) : []);

    res.status(200).json({
      success: true,
      authenticated: true,
      user: {
        ...req.user,
        roleName: role?.name ?? req.user.role,
        subsidiaryAccess,
        moduleAccess,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.getProfile = async (req, res, next) => {
  try {
    const user = await db('app_users')
      .select('id', 'name', 'email', 'role', 'status', 'created_at')
      .where({ id: req.user.userId })
      .first();

    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const perm = await db('user_permissions').where({ user_id: req.user.userId }).first();

    res.json({
      success: true,
      profile: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
        createdAt: user.created_at,
        subsidiaryAccess: perm?.subsidiary_access ?? [],
        moduleAccess: perm?.module_access ?? [],
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─── Tables ─────────────────────────────────────────────────────────────────

exports.listTables = async (req, res, next) => {
  try {
    const allowedModules = req.permissions.isAdmin ? null : req.permissions.moduleAccess;
    const tables = await listClientTables(allowedModules);
    res.status(200).json({ success: true, tables });
  } catch (error) {
    next(error);
  }
};

exports.getTableRows = async (req, res, next) => {
  try {
    const { tableName } = req.params;
    const { page = 1, pageSize = 10, filters } = req.query;
    const parsedFilters = filters ? JSON.parse(filters) : [];
    const allowedModules = req.permissions.isAdmin ? null : req.permissions.moduleAccess;

    const result = await getClientTableRows(
      tableName,
      { page: parseInt(page), pageSize: parseInt(pageSize), filters: parsedFilters },
      req.applySubsidiaryFilter,
      allowedModules,
      req.hasSubsidiaryColumn
    );

    res.status(200).json({ success: true, ...result });
  } catch (error) {
    if (error.statusCode === 403) {
      return res.status(403).json({ success: false, error: error.message });
    }
    next(error);
  }
};

exports.getAllChildRecordsForParent = async (req, res, next) => {
  try {
    const { parentTable, parentRecordId } = req.params;
    const allChildData = await getAllChildRecords(
      parentTable,
      parentRecordId,
      req.applySubsidiaryFilter,
      req.hasSubsidiaryColumn
    );
    res.json({ success: true, ...allChildData });
  } catch (error) {
    next(error);
  }
};

exports.getForeignKeys = async (req, res, next) => {
  try {
    const { tableName } = req.params;
    const foreignKeys = await db('table_metadata')
      .where({ table_name: tableName, is_foreign: true })
      .select('column_name', 'foreign_table', 'foreign_column');
    res.json({ success: true, foreignKeys });
  } catch (error) {
    next(error);
  }
};

exports.getChildTables = async (req, res, next) => {
  try {
    const { tableName } = req.params;
    const childTables = await getChildTables(tableName);
    res.json({ success: true, parentTable: tableName, childTables });
  } catch (error) {
    next(error);
  }
};

exports.getSpecificChildRecords = async (req, res, next) => {
  try {
    const { parentTable, parentRecordId, childTable } = req.params;
    const childData = await getChildRecords(
      parentTable,
      parentRecordId,
      childTable,
      req.applySubsidiaryFilter,
      req.hasSubsidiaryColumn
    );
    res.json({ success: true, parentTable, parentRecordId, ...childData });
  } catch (error) {
    next(error);
  }
};

exports.getChildTableRows = async (req, res, next) => {
  try {
    const { childTableName } = req.params;
    const rows = await getClientTableRows(
      childTableName,
      {},
      req.applySubsidiaryFilter,
      req.permissions.isAdmin ? null : req.permissions.moduleAccess,
      req.hasSubsidiaryColumn
    );
    res.json({ success: true, ...rows });
  } catch (error) {
    next(error);
  }
};
