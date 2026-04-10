const {
  listRoles,
  getRoleById,
  createRole,
  updateRole,
  deleteRole,
} = require('../services/role.service');

/**
 * GET /database/roles
 */
exports.listRoles = async (req, res, next) => {
  try {
    const roles = await listRoles();
    res.json({ success: true, data: roles });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /database/roles/:id
 */
exports.getRole = async (req, res, next) => {
  try {
    const role = await getRoleById(parseInt(req.params.id, 10));
    if (!role) return res.status(404).json({ success: false, error: 'Role not found' });
    res.json({ success: true, data: role });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /database/roles
 * Body: { name, description?, subsidiaryAccess?, moduleAccess? }
 */
exports.createRole = async (req, res, next) => {
  try {
    const { name, description, subsidiaryAccess, moduleAccess } = req.body;
    const role = await createRole({ name, description, subsidiaryAccess, moduleAccess });
    res.status(201).json({ success: true, data: role });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    next(error);
  }
};

/**
 * PUT /database/roles/:id
 * Body: { name?, description?, subsidiaryAccess?, moduleAccess? }
 */
exports.updateRole = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, description, subsidiaryAccess, moduleAccess } = req.body;
    const role = await updateRole(id, { name, description, subsidiaryAccess, moduleAccess });
    res.json({ success: true, data: role });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    next(error);
  }
};

/**
 * DELETE /database/roles/:id
 */
exports.deleteRole = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    await deleteRole(id);
    res.json({ success: true, message: 'Role deleted' });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    next(error);
  }
};
