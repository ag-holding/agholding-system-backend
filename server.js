require('dotenv').config();
const app = require('./src/app');
const logger = require('./src/utils/logger');

// Start workers
// require('./src/queues/workers/table.worker');
// require('./src/queues/workers/data.worker');

const PORT = process.env.PORT ;

app.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT}`);
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});