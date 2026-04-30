const express = require('express');
const router = express.Router();
const userCtrl = require('../controllers/user.controller');
const { verifyToken, requireAdmin } = require('../middlewares/jwt.middleware');

// ─── Public (no auth required) ───────────────────────────────────────────────
router.get('/invite/verify', userCtrl.verifyInviteToken);
router.post('/accept-invite', userCtrl.acceptInvite);

// ─── Password Reset (public) ─────────────────────────────────────────────────
router.post('/forgot-password', userCtrl.requestPasswordReset);
router.get('/reset-password/verify', userCtrl.verifyResetToken);
router.post('/reset-password', userCtrl.resetPassword);

// ─── Authenticated ───────────────────────────────────────────────────────────
router.get('/subsidiaries', verifyToken, userCtrl.getSubsidiaries);
router.get('/modules', verifyToken, requireAdmin, userCtrl.getModules);
router.put('/profile', verifyToken, userCtrl.updateProfile);

// ─── Admin only ──────────────────────────────────────────────────────────────
router.get('/', verifyToken, requireAdmin, userCtrl.listUsers);
router.get('/:id', verifyToken, requireAdmin, userCtrl.getUser);
router.post('/invite', verifyToken, requireAdmin, userCtrl.inviteUser);

// Role assignment (replaces the old per-user subsidiary+module editing)
router.put('/:id/role', verifyToken, requireAdmin, userCtrl.updateUserRole);

router.put('/:id/status', verifyToken, requireAdmin, userCtrl.setUserStatus);

module.exports = router;
