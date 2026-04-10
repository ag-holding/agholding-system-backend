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

// ─── Subsidiaries ────────────────────────────────────────────────────────────

exports.getSubsidiaries = async (req, res, next) => {
  try {
    const subsidiaries = await getSubsidiaries();
    res.json({ success: true, subsidiaries });
  } catch (error) { next(error); }
};

// ─── Modules ─────────────────────────────────────────────────────────────────

exports.getModules = async (req, res, next) => {
  try {
    const modules = await listClientTables(null);
    res.json({ success: true, modules });
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

/**
 * POST /database/users/invite
 * Body: { email, roleId }
 *
 * Simplified: only email + roleId. Subsidiary/module access
 * inherited automatically from the role.
 */
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
      .where({ token, used: false })
      .where('expires_at', '>', new Date())
      .first();

    if (!invite) {
      return res.status(400).json({ success: false, valid: false, error: 'Invalid or expired token' });
    }

    // Fetch role details to show on accept page
    let roleDetails = null;
    if (invite.role_id) {
      const role = await db('app_roles').where({ id: invite.role_id }).first();
      if (role) roleDetails = { id: role.id, name: role.name };
    }

    res.json({
      success: true,
      valid: true,
      email: invite.email,
      role: invite.role,
      roleDetails,
    });
  } catch (error) { next(error); }
};

// ─── Role Assignment (replaces per-user permission editing) ─────────────────

/**
 * PUT /database/users/:id/role
 * Body: { roleId }
 * Admin assigns a different role to a user.
 */
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
