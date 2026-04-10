/**
 * setup.js
 * ─────────────────────────────────────────────────────────────
 * One-time setup script. Run ONCE after deploying:
 *
 *   node setup.js
 *
 * What it does:
 *  1. Runs all pending Knex migrations.
 *  2. Creates the static "Admin" system role (if not present).
 *  3. Creates the first Admin user linked to that role (if not present).
 *
 * Set these env vars (or in .env):
 *   DATABASE_URL, JWT_SECRET
 *   ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD
 */

require('dotenv').config();
const knex = require('knex');
const bcrypt = require('bcryptjs');
const config = require('./knexfile');

async function main() {
  const env = process.env.NODE_ENV || 'development';
  const db = knex(config[env]);

  console.log('\n🔧  Running migrations...');
  await db.migrate.latest();
  console.log('✅  Migrations complete.\n');

  // ── 1. Create the system Admin role ─────────────────────────────────────────
  let adminRole = await db('app_roles').where({ is_system: true }).first();

  if (!adminRole) {
    [adminRole] = await db('app_roles')
      .insert({
        name: 'Admin',
        description: 'Full access to all subsidiaries and modules. Cannot be deleted.',
        subsidiary_access: JSON.stringify([]),  // empty = "all" for system role
        module_access: JSON.stringify([]),       // empty = "all" for system role
        is_system: true,
      })
      .returning('*');
    console.log(`✅  System Admin role created (id: ${adminRole.id})`);
  } else {
    console.log(`ℹ️  System Admin role already exists (id: ${adminRole.id})`);
  }

  // ── 2. Create the seed Admin user ───────────────────────────────────────────
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminName  = process.env.ADMIN_NAME  || 'Admin';
  const adminPass  = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPass) {
    console.warn('⚠️  ADMIN_EMAIL or ADMIN_PASSWORD not set — skipping seed Admin user creation.');
    console.warn('   Set both env vars and re-run setup.js to create an Admin account.\n');
    await db.destroy();
    return;
  }

  const existing = await db('app_users').where({ email: adminEmail }).first();
  if (existing) {
    // Ensure existing admin user is linked to the Admin role
    if (existing.role_id !== adminRole.id) {
      await db('app_users').where({ id: existing.id }).update({
        role_id: adminRole.id,
        role: 'Admin',
        updated_at: new Date(),
      });
      console.log(`🔄  Updated existing admin user to be linked to Admin role: ${adminEmail}`);
    } else {
      console.log(`ℹ️  Admin user already exists: ${adminEmail}`);
    }
  } else {
    const hash = await bcrypt.hash(adminPass, 12);
    const [user] = await db('app_users')
      .insert({
        name: adminName,
        email: adminEmail,
        password_hash: hash,
        role: 'Admin',
        role_id: adminRole.id,
        status: 'Active',
      })
      .returning('*');

    console.log(`✅  Admin user created: ${adminEmail} (id: ${user.id})`);
  }

  await db.destroy();
  console.log('\n🎉  Setup complete! You can now log in at /auth/login.\n');
  console.log('   Next: open Role Management to create custom roles for your team.\n');
}

main().catch((err) => {
  console.error('❌  Setup failed:', err.message);
  process.exit(1);
});
