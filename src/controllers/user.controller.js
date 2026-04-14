const {
  getSubsidiaries,
  listUsers,
  inviteUser,
  acceptInvitation,
  updateUserRole,
  removeUser,
  getUserById,
  requestPasswordReset,
  verifyPasswordResetToken,
  resetPassword,
} = require('../services/user.services');
const { db } = require('../config/database');
const { listClientTables } = require('../services/getdata.services');
const logger = require('../utils/logger');

// ─── Virtual report module IDs ────────────────────────────────────────────────
// These are not DB tables — they are virtual module names that appear in the
// role creation module list alongside real table names.
// Must stay in sync with reports.routes.js requireModuleAccess() calls
// and with REPORT_MODULES in the frontend.
const REPORT_VIRTUAL_MODULES = [
  'report_general_ledger',
  'report_trial_balance',
  'report_income_statement',
  'report_balance_sheet',
  'report_inventory',
  'report_vat_report',
  'report_ap_aging',
  'report_ar_aging',
];

// ─── Subsidiaries ────────────────────────────────────────────────────────────

exports.getSubsidiaries = async (req, res, next) => {
  try {
    const subsidiaries = await getSubsidiaries();
    res.json({ success: true, subsidiaries });
  } catch (error) { next(error); }
};

// ─── Modules (tables + virtual report modules) ───────────────────────────────

/**
 * GET /database/users/modules
 *
 * Returns all DB table names PLUS the virtual report module IDs.
 * Both kinds appear in the role creation module checklist.
 * Admin only.
 */
exports.getModules = async (req, res, next) => {
  try {
    const tables = await listClientTables(null);
    // Append report virtual modules at the end so they appear separately
    const allModules = [...tables, ...REPORT_VIRTUAL_MODULES];
    res.json({ success: true, modules: allModules });
  } catch (error) { next(error); }
};

// ─── Users ───────────────────────────────────────────────────────────────────

exports.listUsers = async (req, res, next) => {
  try {
    const users = await listUsers();
    res.json({ success: true, data: users });
  } catch (error) { next(error); }
};

exports.getUser = async (req, res, next) => {
  try {
    const user = await getUserById(parseInt(req.params.id, 10));
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, data: user });
  } catch (error) { next(error); }
};

// ─── Invitation ──────────────────────────────────────────────────────────────

exports.inviteUser = async (req, res, next) => {
  try {
    const { email, roleId } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'email is required' });
    if (!roleId) return res.status(400).json({ success: false, error: 'roleId is required' });
    const result = await inviteUser({
      email,
      roleId: parseInt(roleId, 10),
      invitedBy: req.user.userId,
    });
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    next(error);
  }
};

exports.acceptInvite = async (req, res, next) => {
  try {
    const { token, name, password } = req.body;
    if (!token || !name || !password) {
      return res.status(400).json({ success: false, error: 'token, name, and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    const user = await acceptInvitation({ token, name, password });
    res.status(201).json({ success: true, message: 'Account created successfully', user });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    next(error);
  }
};

exports.verifyInviteToken = async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, error: 'token is required' });
    const invite = await db('invitation_tokens')
      .where({ token, used: false }).where('expires_at', '>', new Date()).first();
    if (!invite) {
      return res.status(400).json({ success: false, valid: false, error: 'Invalid or expired token' });
    }
    let roleDetails = null;
    if (invite.role_id) {
      const role = await db('app_roles').where({ id: invite.role_id }).first();
      if (role) roleDetails = { id: role.id, name: role.name };
    }
    res.json({ success: true, valid: true, email: invite.email, role: invite.role, roleDetails });
  } catch (error) { next(error); }
};

// ─── Role assignment ─────────────────────────────────────────────────────────

exports.updateUserRole = async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { roleId } = req.body;
    if (!roleId) return res.status(400).json({ success: false, error: 'roleId is required' });
    if (req.user.userId === userId) {
      return res.status(400).json({ success: false, error: 'You cannot change your own role' });
    }
    const result = await updateUserRole(userId, { roleId: parseInt(roleId, 10) });
    res.json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    next(error);
  }
};

exports.removeUser = async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (req.user.userId === userId) {
      return res.status(400).json({ success: false, error: 'You cannot remove yourself' });
    }
    await removeUser(userId);
    res.json({ success: true, message: 'User removed' });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    next(error);
  }
};

// ─── Password Reset ──────────────────────────────────────────────────────────

exports.requestPasswordReset = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'email is required' });
    const result = await requestPasswordReset(email);
    res.json(result);
  } catch (error) { next(error); }
};

exports.verifyResetToken = async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, error: 'token is required' });
    const result = await verifyPasswordResetToken(token);
    res.json({ success: true, ...result });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    next(error);
  }
};

exports.resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ success: false, error: 'token and newPassword are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    const result = await resetPassword({ token, newPassword });
    res.json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    next(error);
  }
};
