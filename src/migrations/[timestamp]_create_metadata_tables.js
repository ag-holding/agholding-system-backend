exports.up = function (knex) {
  return knex.schema
    .createTable("clients", (table) => {
      table.increments("id").primary();
      table.string("account_id").unique().notNullable();
      table.string("company_name").notNullable();
      table.string("email");
      table.string("user_email");
      table.string("bundle_id");
      table.string("website");
      table.string("username");
      table.string("password");
      table.string("host");
      table.integer("port");
      table.string("api_key");
      table.string("database_name").notNullable();
      table.boolean("is_active").defaultTo(true);
      table.timestamps(true, true);
    })
    .createTable("sync_status", (table) => {
      table.increments("id").primary();
      table.string("account_id").notNullable();
      table.string("table_name").notNullable();
      table.enum("status", ["pending", "schema_defined", "in_progress", "completed", "failed"]).defaultTo("pending");
      table.integer("total_records").defaultTo(0);
      table.integer("synced_records").defaultTo(0);
      table.timestamp("last_sync_at");
      table.text("error_message");
      table.timestamps(true, true);
      table.unique(["account_id", "table_name"]);
    });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("sync_status").dropTableIfExists("clients");
};
