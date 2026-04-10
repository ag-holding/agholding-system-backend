// const { Worker } = require('bullmq');
// const logger = require('../../utils/logger');
// const { createTableWithColumns } = require('../../services/database.service');
// const { db } = require('../../config/database');

// const tableWorker = new Worker('table-creation', async (job) => {
//   const { accountId, tableName, columns, database } = job.data;
  
//   logger.info(`[Worker] Starting table creation: ${database}.${tableName}`);
//   logger.info(`[Worker] Columns to create: ${JSON.stringify(columns, null, 2)}`);

//   try {
//     // ✅ CREATE TABLE IN CLIENT'S DATABASE
//     const result = await createTableWithColumns(accountId, tableName, columns);
    
//     if (result.exists) {
//       logger.info(`[Worker] Table ${database}.${tableName} already exists`);
//     } else {
//       logger.info(`[Worker] ✅ Table ${database}.${tableName} created successfully`);
//     }

//     // ✅ UPDATE SYNC STATUS TO COMPLETED
//     await db('sync_status')
//       .where({ account_id: accountId, table_name: tableName })
//       .update({
//         status: 'completed',
//         updated_at: new Date()
//       });

//     logger.info(`[Worker] ✅ Sync status updated to 'completed' for ${tableName}`);

//     return { 
//       success: true, 
//       database, 
//       table: tableName,
//       columnsCreated: columns.length 
//     };

//   } catch (error) {
//     logger.error(`[Worker] ❌ Failed to create table ${tableName}: ${error.message}`);
//     logger.error(`[Worker] Stack trace: ${error.stack}`);
    
//     // ✅ UPDATE SYNC STATUS TO FAILED
//     await db('sync_status')
//       .where({ account_id: accountId, table_name: tableName })
//       .update({
//         status: 'failed',
//         error_message: error.message,
//         updated_at: new Date()
//       });
    
//     throw error;
//   }
// }, {
//   connection: require('../../config/redis'),
//   concurrency: 5,
//   removeOnComplete: { count: 100 },
//   removeOnFail: { count: 100 }
// });

// tableWorker.on('completed', (job, result) => {
//   logger.info(`[Worker] ✅ Job ${job.id} completed successfully`);
//   logger.info(`[Worker] Result: ${JSON.stringify(result)}`);
// });

// tableWorker.on('failed', (job, err) => {
//   logger.error(`[Worker] ❌ Job ${job?.id} failed`);
//   logger.error(`[Worker] Error: ${err.message}`);
// });

// tableWorker.on('error', (err) => {
//   logger.error(`[Worker] Worker error: ${err.message}`);
// });

// logger.info('✅ Table creation worker started');

// module.exports = tableWorker;