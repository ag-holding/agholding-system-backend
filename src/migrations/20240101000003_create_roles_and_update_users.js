/**
 * Migration: Role Management
 *
 * 1. Creates `app_roles` — permission templates with subsidiary + module access.
 * 2. Adds `role_id` FK to `app_users`   — which role this user belongs to.
 * 3. Adds `role_id` FK to `invitation_tokens` — which role the invitee will get.
 *
 * The static "Admin" role (is_system = true) grants full access to everything.
 * It is seeded by setup.js and cannot be deleted.
 *
 * For non-admin users permissions are loaded at runtime from app_roles,
 * so any change to a role's subsidiary_access / module_access instantly
 * applies to every user assigned to that role.
 */

exports.up = async function (knex) {
  // ── 1. app_roles ────────────────────────────────────────────────────────────
  const hasRoles = await knex.schema.hasTable('app_roles');
  if (!hasRoles) {
    await knex.schema.createTable('app_roles', (t) => {
      t.increments('id').primary();
      t.string('name', 100).notNullable().unique();
      t.string('description', 500).nullable();
      // null = all (only valid for is_system Admin). [] = none. [...] = explicit list.
      t.jsonb('subsidiary_access').notNullable().defaultTo('[]');
      t.jsonb('module_access').notNullable().defaultTo('[]');
      t.boolean('is_system').notNullable().defaultTo(false); // protects Admin from deletion
      t.timestamps(true, true);
    });
  }

  // ── 2. app_users — add role_id ─────────────────────────────────────────────
  const hasRoleIdOnUsers = await knex.schema.hasColumn('app_users', 'role_id');
  if (!hasRoleIdOnUsers) {
    await knex.schema.alterTable('app_users', (t) => {
      t.integer('role_id').nullable().references('id').inTable('app_roles').onDelete('SET NULL');
    });
  }

  // ── 3. invitation_tokens — add role_id ────────────────────────────────────
  const hasRoleIdOnTokens = await knex.schema.hasColumn('invitation_tokens', 'role_id');
  if (!hasRoleIdOnTokens) {
    await knex.schema.alterTable('invitation_tokens', (t) => {
      t.integer('role_id').nullable().references('id').inTable('app_roles').onDelete('SET NULL');
    });
  }
};

exports.down = async function (knex) {
  // Remove FK columns first, then table
  const hasRoleIdOnTokens = await knex.schema.hasColumn('invitation_tokens', 'role_id');
  if (hasRoleIdOnTokens) {
    await knex.schema.alterTable('invitation_tokens', (t) => t.dropColumn('role_id'));
  }

  const hasRoleIdOnUsers = await knex.schema.hasColumn('app_users', 'role_id');
  if (hasRoleIdOnUsers) {
    await knex.schema.alterTable('app_users', (t) => t.dropColumn('role_id'));
  }

  await knex.schema.dropTableIfExists('app_roles');
};
