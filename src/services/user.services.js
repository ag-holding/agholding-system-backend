const { db } = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { sendInvitationEmail } = require('../utils/mailer');

const INVITE_EXPIRY_HOURS = 72;
const PASSWORD_RESET_EXPIRY_HOURS = 1;

// ─── Subsidiaries ────────────────────────────────────────────────────────────

async function getSubsidiaries() {
  const hasTable = await db.schema.hasTable('subsidiary');
  if (hasTable) {
    const rows = await db('subsidiary').select('*');
    return rows.map(row => ({ ...row, name: row.name ? row.name.trim() : row.name }));
  }
  return [];
}

// ─── Users ───────────────────────────────────────────────────────────────────

async function listUsers() {
  const users = await db('app_users')
    .select(
      'app_users.id',
      'app_users.name',
      'app_users.email',
      'app_users.role',
      'app_users.role_id',
      'app_users.status',
      'app_users.created_at',
      'app_roles.name as role_name',
      'app_roles.subsidiary_access',
      'app_roles.module_access',
    )
    .leftJoin('app_roles', 'app_users.role_id', 'app_roles.id')
    .orderBy('app_users.created_at', 'asc');

  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    roleId: u.role_id,
    roleName: u.role_name ?? u.role,
    status: u.status,
    createdAt: u.created_at,
    subsidiaryAccess: parseJsonb(u.subsidiary_access),
    moduleAccess: parseJsonb(u.module_access),
  }));
}

/**
 * inviteUser
 * Simplified: only requires email + roleId.
 * Subsidiary and module access come from the role at runtime.
 */
async function inviteUser({ email, roleId, invitedBy }) {
  // Validate role exists
  const role = await db('app_roles').where({ id: roleId }).first();
  if (!role) {
    throw Object.assign(new Error('Selected role not found'), { statusCode: 400 });
  }

  const existing = await db('app_users').where({ email }).first();
  if (existing) {
    throw Object.assign(new Error('A user with this email already exists'), { statusCode: 409 });
  }

  const pendingInvite = await db('invitation_tokens')
    .where({ email, used: false })
    .where('expires_at', '>', new Date())
    .first();

  if (pendingInvite) {
    await sendInvitationEmail({ email, token: pendingInvite.token });
    return { resent: true, email };
  }

  const token = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

  await db('invitation_tokens').insert({
    token,
    email,
    role: role.name,           // keep legacy field populated
    role_id: roleId,
    // legacy fields — keep nullable, permissions come from role at runtime
    subsidiary_access: JSON.stringify([]),
    module_access: JSON.stringify([]),
    invited_by: invitedBy,
    expires_at: expiresAt,
    used: false,
  });

  await sendInvitationEmail({ email, token });
  logger.info(`Invitation sent to ${email} (role: ${role.name}) by user ${invitedBy}`);
  return { sent: true, email };
}

/**
 * acceptInvitation
 * Creates the app_users row linked to the role from the invite token.
 */
async function acceptInvitation({ token, name, password }) {
  const invite = await db('invitation_tokens')
    .where({ token, used: false })
    .where('expires_at', '>', new Date())
    .first();

  if (!invite) {
    throw Object.assign(new Error('Invalid or expired invitation token'), { statusCode: 400 });
  }

  // Determine whether this is an Admin role
  let isAdminRole = false;
  if (invite.role_id) {
    const role = await db('app_roles').where({ id: invite.role_id }).first();
    isAdminRole = role?.is_system === true;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const [user] = await db('app_users')
    .insert({
      name,
      email: invite.email,
      password_hash: passwordHash,
      role: isAdminRole ? 'Admin' : (invite.role ?? 'User'),
      role_id: invite.role_id ?? null,
      status: 'Active',
      invited_by: invite.invited_by,
    })
    .returning(['id', 'name', 'email', 'role', 'role_id', 'status']);

  // Create an empty user_permissions row (permissions resolved from role at runtime)
  await db('user_permissions').insert({
    user_id: user.id,
    subsidiary_access: JSON.stringify([]),
    module_access: JSON.stringify([]),
  }).onConflict('user_id').ignore();

  await db('invitation_tokens').where({ id: invite.id }).update({ used: true });
  return user;
}

/**
 * updateUserRole — replaces the old updateUserPermissions.
 * Admin assigns a different role_id to a user.
 */
async function updateUserRole(userId, { roleId }) {
  const user = await db('app_users').where({ id: userId }).first();
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });

  const role = await db('app_roles').where({ id: roleId }).first();
  if (!role) throw Object.assign(new Error('Role not found'), { statusCode: 404 });

  await db('app_users').where({ id: userId }).update({
    role_id: roleId,
    role: role.is_system ? 'Admin' : (role.name ?? 'User'),
    updated_at: new Date(),
  });

  return { success: true };
}

async function removeUser(userId) {
  const user = await db('app_users').where({ id: userId }).first();
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
  await db('app_users').where({ id: userId }).delete();
  return { success: true };
}

async function getUserById(userId) {
  const user = await db('app_users')
    .select(
      'app_users.id', 'app_users.name', 'app_users.email',
      'app_users.role', 'app_users.role_id', 'app_users.status',
      'app_roles.name as role_name',
      'app_roles.subsidiary_access', 'app_roles.module_access',
    )
    .leftJoin('app_roles', 'app_users.role_id', 'app_roles.id')
    .where('app_users.id', userId)
    .first();

  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    roleId: user.role_id,
    roleName: user.role_name ?? user.role,
    status: user.status,
    subsidiaryAccess: parseJsonb(user.subsidiary_access),
    moduleAccess: parseJsonb(user.module_access),
  };
}

// ─── Password Reset ──────────────────────────────────────────────────────────

async function requestPasswordReset(email) {
  const user = await db('app_users').where({ email }).first();
  if (!user) {
    logger.info(`Password reset requested for non-existent email: ${email}`);
    return { success: true, message: 'If the email exists, a reset link has been sent' };
  }

  const existingToken = await db('password_reset_tokens')
    .where({ email, used: false })
    .where('expires_at', '>', new Date())
    .first();

  if (existingToken) {
    const { sendPasswordResetEmail } = require('../utils/mailer');
    await sendPasswordResetEmail({ email, token: existingToken.token });
    return { success: true, message: 'If the email exists, a reset link has been sent' };
  }

  const token = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_HOURS * 60 * 60 * 1000);

  await db('password_reset_tokens').insert({ email, token, expires_at: expiresAt, used: false });

  const { sendPasswordResetEmail } = require('../utils/mailer');
  await sendPasswordResetEmail({ email, token });

  logger.info(`Password reset token sent to ${email}`);
  return { success: true, message: 'If the email exists, a reset link has been sent' };
}

async function verifyPasswordResetToken(token) {
  const resetToken = await db('password_reset_tokens')
    .where({ token, used: false }).where('expires_at', '>', new Date()).first();
  if (!resetToken) throw Object.assign(new Error('Invalid or expired reset token'), { statusCode: 400 });
  return { valid: true, email: resetToken.email };
}

async function resetPassword({ token, newPassword }) {
  const resetToken = await db('password_reset_tokens')
    .where({ token, used: false }).where('expires_at', '>', new Date()).first();
  if (!resetToken) throw Object.assign(new Error('Invalid or expired reset token'), { statusCode: 400 });

  const user = await db('app_users').where({ email: resetToken.email }).first();
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });

  const passwordHash = await bcrypt.hash(newPassword, 12);

  await db.transaction(async (trx) => {
    await trx('app_users').where({ id: user.id }).update({ password_hash: passwordHash, updated_at: new Date() });
    await trx('password_reset_tokens').where({ id: resetToken.id }).update({ used: true });
  });

  logger.info(`Password successfully reset for user: ${user.email}`);
  return { success: true, message: 'Password reset successfully' };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseJsonb(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') { try { return JSON.parse(val); } catch { return []; } }
  return val ?? [];
}

module.exports = {
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
};
