const express = require('express');
const router = express.Router();
const roleCtrl = require('../controllers/role.controller');
const { verifyToken, requireAdmin } = require('../middlewares/jwt.middleware');

// All role management endpoints require Admin
router.use(verifyToken, requireAdmin);

router.get('/', roleCtrl.listRoles);
router.get('/:id', roleCtrl.getRole);
router.post('/', roleCtrl.createRole);
router.put('/:id', roleCtrl.updateRole);
router.delete('/:id', roleCtrl.deleteRole);

module.exports = router;
