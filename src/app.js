const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const databaseRoutes = require('./routes/database.routes');
const userRoutes = require('./routes/user.routes');
const reportsRoutes = require('./routes/reports.routes');
const netsuiteRoutes = require('./routes/netsuite.routes');
const fileUploadRoutes = require('./routes/fileUpload.routes');
const apiKeyMiddleware = require('./middlewares/apiKey.middleware');
const errorMiddleware = require('./middlewares/error.middleware');

const app = express();

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/database', databaseRoutes);
app.use('/api/database/users', userRoutes);
app.use('/api/reports', reportsRoutes);                // ← Reports
app.use('/api/netsuite', apiKeyMiddleware, netsuiteRoutes);
app.use('/api/files', fileUploadRoutes);

app.get('/health', (req, res) => res.json({ status: 'OK', timestamp: new Date() }));
app.use(errorMiddleware);

module.exports = app;
