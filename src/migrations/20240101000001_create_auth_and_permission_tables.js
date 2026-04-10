/**
 * Migration: Single-Tenant Auth + Permission Tables
 *
 * Creates three tables inside the client's own database:
 *
 *  app_users           – Users who can log in to this application.
 *  user_permissions    – Per-user subsidiary + module access grants.
 *  invitation_tokens   – One-time tokens sent via email to invite new users.
 *
 * NOTE: We intentionally avoid naming this table "users" because many
 * client databases already have a business-data table called "users".
 */

exports.up = async function (knex) {
  // ── 1. app_users ────────────────────────────────────────────────────────────
  const hasUsers = await knex.schema.hasTable('app_users');
  if (!hasUsers) {
    await knex.schema.createTable('app_users', (t) => {
      t.increments('id').primary();
      t.string('name', 255);
      t.string('email', 255).notNullable().unique();
      t.string('password_hash', 255);          // bcrypt hash; null until invite accepted
      t.string('role', 50).notNullable().defaultTo('User'); // Admin | User | Viewer
      t.string('status', 50).notNullable().defaultTo('Pending'); // Active | Pending | Inactive
      t.integer('invited_by').references('id').inTable('app_users').onDelete('SET NULL');
      t.timestamps(true, true);
    });
  }

  // ── 2. user_permissions ─────────────────────────────────────────────────────
  const hasPerms = await knex.schema.hasTable('user_permissions');
  if (!hasPerms) {
    await knex.schema.createTable('user_permissions', (t) => {
      t.increments('id').primary();
      t.integer('user_id').notNullable().references('id').inTable('app_users').onDelete('CASCADE');
      // Array of subsidiary names the user can see, e.g. ["Sub A","Sub B"]
      t.jsonb('subsidiary_access').notNullable().defaultTo('[]');
      // Array of table/module names the user can access, e.g. ["customers","invoices"]
      t.jsonb('module_access').notNullable().defaultTo('[]');
      t.timestamps(true, true);
      t.unique(['user_id']);
    });
  }

  // ── 3. invitation_tokens ────────────────────────────────────────────────────
  const hasInv = await knex.schema.hasTable('invitation_tokens');
  if (!hasInv) {
    await knex.schema.createTable('invitation_tokens', (t) => {
      t.increments('id').primary();
      t.string('token', 128).notNullable().unique();
      t.string('email', 255).notNullable();
      t.string('role', 50).notNullable().defaultTo('User');
      t.jsonb('subsidiary_access').notNullable().defaultTo('[]');
      t.jsonb('module_access').notNullable().defaultTo('[]');
      t.integer('invited_by').references('id').inTable('app_users').onDelete('SET NULL');
      t.boolean('used').notNullable().defaultTo(false);
      t.timestamp('expires_at').notNullable();
      t.timestamps(true, true);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('invitation_tokens');
  await knex.schema.dropTableIfExists('user_permissions');
  await knex.schema.dropTableIfExists('app_users');
};
