const { db } = require('../config/database');
const logger = require('../utils/logger');

/**
 * listRoles
 * Returns all roles with a count of how many users are assigned to each.
 */
async function listRoles() {
  const roles = await db('app_roles')
    .leftJoin(
      db('app_users').select('role_id', db.raw('COUNT(*) as user_count')).groupBy('role_id').as('uc'),
      'app_roles.id', 'uc.role_id'
    )
    .select(
      'app_roles.id',
      'app_roles.name',
      'app_roles.description',
      'app_roles.subsidiary_access',
      'app_roles.module_access',
      'app_roles.is_system',
      'app_roles.created_at',
      db.raw('COALESCE(uc.user_count, 0) as user_count')
    )
    .orderBy('app_roles.is_system', 'desc') // Admin first
    .orderBy('app_roles.name', 'asc');

  return roles.map(normalizeRole);
}

/**
 * getRoleById
 */
async function getRoleById(id) {
  const role = await db('app_roles').where({ id }).first();
  if (!role) return null;
  return normalizeRole(role);
}

/**
 * createRole
 * Body: { name, description, subsidiaryAccess, moduleAccess }
 */
async function createRole({ name, description, subsidiaryAccess, moduleAccess }) {
  if (!name || !name.trim()) {
    throw Object.assign(new Error('Role name is required'), { statusCode: 400 });
  }

  // Prevent creating a role named "Admin" (reserved for the system role)
  if (name.trim().toLowerCase() === 'admin') {
    throw Object.assign(new Error('"Admin" is a reserved role name'), { statusCode: 400 });
  }

  const existing = await db('app_roles').whereRaw('LOWER(name) = ?', [name.trim().toLowerCase()]).first();
  if (existing) {
    throw Object.assign(new Error(`A role named "${name.trim()}" already exists`), { statusCode: 409 });
  }

  const [role] = await db('app_roles')
    .insert({
      name: name.trim(),
      description: description?.trim() || null,
      subsidiary_access: JSON.stringify(subsidiaryAccess ?? []),
      module_access: JSON.stringify(moduleAccess ?? []),
      is_system: false,
    })
    .returning('*');

  logger.info(`Role created: ${role.name} (id: ${role.id})`);
  return normalizeRole(role);
}

/**
 * updateRole
 */
async function updateRole(id, { name, description, subsidiaryAccess, moduleAccess }) {
  const role = await db('app_roles').where({ id }).first();
  if (!role) throw Object.assign(new Error('Role not found'), { statusCode: 404 });

  if (role.is_system) {
    throw Object.assign(new Error('The system Admin role cannot be modified'), { statusCode: 403 });
  }

  if (name && name.trim().toLowerCase() === 'admin') {
    throw Object.assign(new Error('"Admin" is a reserved role name'), { statusCode: 400 });
  }

  // Check name uniqueness (excluding self)
  if (name && name.trim().toLowerCase() !== role.name.toLowerCase()) {
    const dupe = await db('app_roles')
      .whereRaw('LOWER(name) = ?', [name.trim().toLowerCase()])
      .whereNot({ id })
      .first();
    if (dupe) {
      throw Object.assign(new Error(`A role named "${name.trim()}" already exists`), { statusCode: 409 });
    }
  }

  const updatePayload = { updated_at: new Date() };
  if (name !== undefined) updatePayload.name = name.trim();
  if (description !== undefined) updatePayload.description = description?.trim() || null;
  if (subsidiaryAccess !== undefined) updatePayload.subsidiary_access = JSON.stringify(subsidiaryAccess);
  if (moduleAccess !== undefined) updatePayload.module_access = JSON.stringify(moduleAccess);

  const [updated] = await db('app_roles').where({ id }).update(updatePayload).returning('*');
  logger.info(`Role updated: ${updated.name} (id: ${updated.id})`);
  return normalizeRole(updated);
}

/**
 * deleteRole
 * Cannot delete a system role or a role that still has users assigned.
 */
async function deleteRole(id) {
  const role = await db('app_roles').where({ id }).first();
  if (!role) throw Object.assign(new Error('Role not found'), { statusCode: 404 });

  if (role.is_system) {
    throw Object.assign(new Error('The system Admin role cannot be deleted'), { statusCode: 403 });
  }

  const userCount = await db('app_users').where({ role_id: id }).count('id as count').first();
  if (parseInt(userCount.count, 10) > 0) {
    throw Object.assign(
      new Error(`Cannot delete: ${userCount.count} user(s) are assigned to this role. Re-assign them first.`),
      { statusCode: 409 }
    );
  }

  await db('app_roles').where({ id }).delete();
  logger.info(`Role deleted: ${role.name} (id: ${id})`);
  return { success: true };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeRole(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description || '',
    subsidiaryAccess: parseJsonb(r.subsidiary_access),
    moduleAccess: parseJsonb(r.module_access),
    isSystem: r.is_system,
    userCount: parseInt(r.user_count ?? 0, 10),
    createdAt: r.created_at,
  };
}

function parseJsonb(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return []; }
  }
  return val ?? [];
}

module.exports = {
  listRoles,
  getRoleById,
  createRole,
  updateRole,
  deleteRole,
};
