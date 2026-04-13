const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/reports.controller');
const { verifyToken } = require('../middlewares/jwt.middleware');
const { loadUserPermissions, subsidiaryFilter } = require('../middlewares/permission.middleware');

// All report routes require JWT + permissions loaded
const auth = [verifyToken, loadUserPermissions, subsidiaryFilter];

// Fetch available periods from GLImpact_table (or any table via ?table=)
router.get('/periods', ...auth, ctrl.getPeriods);

// Individual reports — all accept ?fromPeriod=jan-24&toPeriod=dec-24&subsidiaries=Sub A,Sub B
router.get('/general-ledger',   ...auth, ctrl.generalLedger);
router.get('/trial-balance',    ...auth, ctrl.trialBalance);
router.get('/income-statement', ...auth, ctrl.incomeStatement);
router.get('/balance-sheet',    ...auth, ctrl.balanceSheet);
router.get('/inventory',        ...auth, ctrl.inventoryReport);
router.get('/vat-report',       ...auth, ctrl.vatReport);
router.get('/ap-aging',         ...auth, ctrl.apAging);
router.get('/ar-aging',         ...auth, ctrl.arAging);

module.exports = router;
