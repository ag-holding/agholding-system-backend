/**
 * apiKey.middleware.js  –  Single-Tenant version
 *
 * Previously this middleware looked up the API key in a master `clients`
 * table.  In single-tenant mode there is no master DB, so we compare
 * against a static key stored in the environment variable APP_API_KEY.
 *
 * Usage:  Set APP_API_KEY in your .env, then pass that value as the
 *         x-api-key header when calling NetSuite webhook routes.
 */
module.exports = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({ success: false, error: 'x-api-key header is required' });
  }

  const expected = process.env.APP_API_KEY;
  if (!expected) {
    // If the env variable is missing, deny all requests and log loudly.
    console.error('[apiKey.middleware] APP_API_KEY is not set in environment variables');
    return res.status(500).json({ success: false, error: 'Server misconfiguration' });
  }

  if (apiKey !== expected) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }

  next();
};
