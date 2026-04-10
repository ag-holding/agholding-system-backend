/**
 * Migration: Create password_reset_tokens table
 * ─────────────────────────────────────────────────────────────
 * Stores temporary tokens for password reset flow.
 * Tokens expire after a set duration (default: 1 hour).
 */

exports.up = async function (knex) {
  await knex.schema.createTable('password_reset_tokens', (t) => {
    t.increments('id').primary();
    t.string('email').notNullable();
    t.string('token', 128).notNullable().unique();
    t.boolean('used').defaultTo(false);
    t.timestamp('expires_at').notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index('email');
    t.index('token');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('password_reset_tokens');
};
