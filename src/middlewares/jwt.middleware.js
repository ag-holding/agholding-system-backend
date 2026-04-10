const jwt = require('jsonwebtoken');

/**
 * verifyToken
 * Validates the JWT stored in the `auth_token` HTTP-only cookie
 * (or falls back to the Authorization header for API clients).
 *
 * After single-tenant conversion there is no accountId / Key cookie.
 * The JWT payload carries: { userId, email, name, role }
 */
exports.verifyToken = (req, res, next) => {
  let token = req.cookies?.auth_token;

  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { userId, email, name, role, iat, exp }
    next();
  } catch (error) {
    res.clearCookie('auth_token');
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
};

/**
 * requireAdmin
 * Must be used AFTER verifyToken.
 * Only allows users with role === 'Admin' to proceed.
 */
exports.requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'Admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
};
