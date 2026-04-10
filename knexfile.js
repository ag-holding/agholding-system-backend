require('dotenv').config();
const knex = require('knex');

const testClientDatabaseConnection = async ({ host, port, user, password, database }) => {
  const testDb = knex({
    client: 'pg',
    connection: {
      host,
      port: port || 5432,
      user,
      password,
      database,
      ssl: { rejectUnauthorized: false },
    },
  });

  try {
    await testDb.raw('SELECT 1');
    await testDb.destroy();
    return { exists: true, message: 'Database connection successful.' };
  } catch (error) {
    await testDb.destroy();
    return { exists: false, message: error.message };
  }
};

// Single-tenant: DATABASE_URL points directly to the client's database.
// No master/main database is required.
module.exports = {
  development: {
    client: 'pg',
    connection: {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    },
    migrations: {
      directory: './src/migrations',
    },
    pool: { min: 2, max: 10 },
  },

  production: {
    client: 'pg',
    connection: {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    },
    migrations: {
      directory: './src/migrations',
    },
    pool: { min: 2, max: 20 },
  },

  testClientDatabaseConnection,
};
