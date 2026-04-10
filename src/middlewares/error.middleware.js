const logger = require('../utils/logger');

module.exports = (err, req, res, next) => {
  logger.error(err);
  
  res.status(err.status || 500).json({
    success: false,
    error: {
      message: err.message || 'Internal Server Error',
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    }
  });
};