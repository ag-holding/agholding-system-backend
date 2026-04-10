// const { Queue, Worker } = require('bullmq');
// const redisClient = require('../config/redis');

// // Create connection object for BullMQ
// const connection = {
//   host: process.env.REDIS_HOST || 'localhost',
//   port: process.env.REDIS_PORT || 6379,
//   password: process.env.REDIS_PASSWORD || undefined
// };

// // Define queues
// const tableCreationQueue = new Queue('table-creation', { connection });
// const dataInsertionQueue = new Queue('data-insertion', { connection });

// module.exports = {
//   tableCreationQueue,
//   dataInsertionQueue,
//   connection
// };