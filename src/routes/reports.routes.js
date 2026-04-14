const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/reports.controller');
const { verifyToken } = require('../middlewares/jwt.middleware');
const {
  loadUserPermissions,
  subsidiaryFilter,
  requireModuleAccess,
} = require('../middlewares/permission.middleware');

// Base auth stack — JWT + permissions loaded
const auth = [verifyToken, loadUserPermissions, subsidiaryFilter];

// Periods endpoint — accessible to anyone with report access
// (no individual report guard needed — it's just metadata)
router.get('/periods', ...auth, ctrl.getPeriods);

// ─── Each report guarded by its own virtual module ID ─────────────────────────
// These IDs must match exactly what is stored in user_permissions.module_access
// and what is returned by GET /api/database/users/modules

router.get(
  '/general-ledger',
  ...auth, requireModuleAccess('report_general_ledger'),
  ctrl.generalLedger
);

router.get(
  '/trial-balance',
  ...auth, requireModuleAccess('report_trial_balance'),
  ctrl.trialBalance
);

router.get(
  '/income-statement',
  ...auth, requireModuleAccess('report_income_statement'),
  ctrl.incomeStatement
);

router.get(
  '/balance-sheet',
  ...auth, requireModuleAccess('report_balance_sheet'),
  ctrl.balanceSheet
);

router.get(
  '/inventory',
  ...auth, requireModuleAccess('report_inventory'),
  ctrl.inventoryReport
);

router.get(
  '/vat-report',
  ...auth, requireModuleAccess('report_vat_report'),
  ctrl.vatReport
);

router.get(
  '/ap-aging',
  ...auth, requireModuleAccess('report_ap_aging'),
  ctrl.apAging
);

router.get(
  '/ar-aging',
  ...auth, requireModuleAccess('report_ar_aging'),
  ctrl.arAging
);

module.exports = router;
