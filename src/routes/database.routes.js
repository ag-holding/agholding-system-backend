const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/database.controller');
const userCtrl = require('../controllers/user.controller');
const { verifyToken, requireAdmin } = require('../middlewares/jwt.middleware');
const {
  loadUserPermissions,
  checkModuleAccess,
  subsidiaryFilter,
} = require('../middlewares/permission.middleware');

// Convenience: authenticated + permissions loaded + subsidiary filter helper attached
const auth = [verifyToken, loadUserPermissions, subsidiaryFilter];

// ─── Auth ────────────────────────────────────────────────────────────────────
router.post('/auth/login', ctrl.loginUser);
router.post('/auth/logout', ctrl.logoutUser);
router.get('/auth/check', verifyToken, ctrl.checkAuth);
router.get('/auth/me', verifyToken, ctrl.getProfile);

// Password Reset (public endpoints)
router.post('/auth/forgot-password', userCtrl.requestPasswordReset);
router.get('/auth/reset-password/verify', userCtrl.verifyResetToken);
router.post('/auth/reset-password', userCtrl.resetPassword);

// ─── Tables ──────────────────────────────────────────────────────────────────
router.get('/tables', ...auth, ctrl.listTables);

router.get(
  '/tables/:tableName/rows',
  ...auth, checkModuleAccess,
  ctrl.getTableRows
);

router.get(
  '/tables/:tableName/foreign-keys',
  ...auth, checkModuleAccess,
  ctrl.getForeignKeys
);

router.get(
  '/tables/:tableName/children',
  ...auth, checkModuleAccess,
  ctrl.getChildTables
);

router.get(
  '/tables/:childTableName/child-rows',
  ...auth,
  ctrl.getChildTableRows
);

// ─── Child / Parent record relations ─────────────────────────────────────────
router.get(
  '/tables/:parentTable/records/:parentRecordId/all-children',
  ...auth, checkModuleAccess,
  ctrl.getAllChildRecordsForParent
);

router.get(
  '/tables/:parentTable/records/:parentRecordId/children/:childTable',
  ...auth, checkModuleAccess,
  ctrl.getSpecificChildRecords
);

module.exports = router;
