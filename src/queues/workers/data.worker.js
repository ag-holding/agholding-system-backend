// const { Worker } = require('bullmq');
// const logger = require('../../utils/logger');
// const { insertBatchData } = require('../../services/database.service');
// const { db } = require('../../config/database');

// const dataWorker = new Worker('data-insertion', async (job) => {
//   const { accountId, tableName, data, batchId, database } = job.data;
  
//   logger.info(`[Data Worker] Inserting ${data.length} records into ${database}.${tableName}`);

//   try {
//     // ✅ INSERT DATA INTO CLIENT DATABASE
//     const result = await insertBatchData(accountId, tableName, data, batchId);
    
//     logger.info(`[Data Worker] ✅ Inserted ${result.inserted} records into ${database}.${tableName}`);

//     // ✅ UPDATE SYNC STATUS
//     await db('sync_status')
//       .where({ account_id: accountId, table_name: tableName })
//       .update({
//         synced_records: db.raw('synced_records + ?', [result.inserted]),
//         last_sync_at: new Date(),
//         status: 'completed',
//         updated_at: new Date()
//       });

//     logger.info(`[Data Worker] ✅ Sync status updated for ${tableName}`);

//     return { success: true, inserted: result.inserted, database, table: tableName };

//   } catch (error) {
//     logger.error(`[Data Worker] ❌ Failed to insert data into ${tableName}: ${error.message}`);
//     logger.error(`[Data Worker] Stack trace: ${error.stack}`);
    
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
//   concurrency: 10,
//   removeOnComplete: { count: 100 },
//   removeOnFail: { count: 100 }
// });

// dataWorker.on('completed', (job, result) => {
//   logger.info(`[Data Worker] ✅ Job ${job.id} completed: ${result.inserted} records inserted`);
// });

// dataWorker.on('failed', (job, err) => {
//   logger.error(`[Data Worker] ❌ Job ${job?.id} failed: ${err.message}`);
// });

// dataWorker.on('error', (err) => {
//   logger.error(`[Data Worker] Worker error: ${err.message}`);
// });

// logger.info('✅ Data insertion worker started');

// module.exports = dataWorker;