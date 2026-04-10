const knex = require('knex');

// Single-tenant: one direct connection to the client's database.
// No main/master database is needed. All tables (including app_users,
// user_permissions, invitation_tokens) live in the client's own DB.

const db = knex({
  client: 'pg',
  connection: {
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },  // uncomment for cloud providers
  },
  pool: {
    min: 2,
    max: 10,
  },
});

module.exports = { db };
