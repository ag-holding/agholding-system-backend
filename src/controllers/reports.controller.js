const {
  getAvailablePeriods,
  getGeneralLedger,
  getTrialBalance,
  getIncomeStatement,
  getBalanceSheet,
  getInventoryReport,
  getVatReport,
  getAPAging,
  getARAging,
  getSalesByTaxcode,
  getPurchaseByTaxcode,
} = require('../services/reports.service');

const logger = require('../utils/logger');

// Table that holds period data — default GLImpact_table but can be overridden
const GL_TABLE = 'GLImpact_table';

// ─── Helper: extract common filter params ────────────────────────────────────
function extractFilters(req) {
  const { fromPeriod, toPeriod, subsidiaries } = req.query;

  // Subsidiaries come directly from the UI filter — no role-based restriction
  const effectiveSubs = subsidiaries
    ? (Array.isArray(subsidiaries) ? subsidiaries : subsidiaries.split(','))
    : [];

  return { fromPeriod, toPeriod, subsidiaries: effectiveSubs };
}

// ─── GET /api/reports/periods?table=GLImpact_table ───────────────────────────
exports.getPeriods = async (req, res, next) => {
  try {
    const tableName = req.query.table || GL_TABLE;
    const periods = await getAvailablePeriods(tableName);
    res.json({ success: true, periods });
  } catch (err) { next(err); }
};

// ─── POST /api/reports/general-ledger ────────────────────────────────────────
exports.generalLedger = async (req, res, next) => {
  try {
    const { fromPeriod, toPeriod, subsidiaries } = extractFilters(req);
    if (!fromPeriod || !toPeriod) {
      return res.status(400).json({ success: false, error: 'fromPeriod and toPeriod are required' });
    }
    const rows = await getGeneralLedger({ fromPeriod, toPeriod, subsidiaries });
    res.json({ success: true, report: 'general-ledger', fromPeriod, toPeriod, rowCount: rows.length, data: rows });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
    next(err);
  }
};

// ─── GET /api/reports/trial-balance ──────────────────────────────────────────
exports.trialBalance = async (req, res, next) => {
  try {
    const { fromPeriod, toPeriod, subsidiaries } = extractFilters(req);
    if (!fromPeriod || !toPeriod) {
      return res.status(400).json({ success: false, error: 'fromPeriod and toPeriod are required' });
    }
    const rows = await getTrialBalance({ fromPeriod, toPeriod, subsidiaries });
    res.json({ success: true, report: 'trial-balance', fromPeriod, toPeriod, rowCount: rows.length, data: rows });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
    next(err);
  }
};

// ─── GET /api/reports/income-statement ────────────────────────────────────────
exports.incomeStatement = async (req, res, next) => {
  try {
    const { fromPeriod, toPeriod, subsidiaries } = extractFilters(req);
    if (!fromPeriod || !toPeriod) {
      return res.status(400).json({ success: false, error: 'fromPeriod and toPeriod are required' });
    }
    const rows = await getIncomeStatement({ fromPeriod, toPeriod, subsidiaries });
    res.json({ success: true, report: 'income-statement', fromPeriod, toPeriod, rowCount: rows.length, data: rows });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
    next(err);
  }
};

// ─── GET /api/reports/balance-sheet ──────────────────────────────────────────
exports.balanceSheet = async (req, res, next) => {
  try {
    const { fromPeriod, toPeriod, subsidiaries } = extractFilters(req);
    if (!fromPeriod || !toPeriod) {
      return res.status(400).json({ success: false, error: 'fromPeriod and toPeriod are required' });
    }
    const rows = await getBalanceSheet({ fromPeriod, toPeriod, subsidiaries });
    res.json({ success: true, report: 'balance-sheet', fromPeriod, toPeriod, rowCount: rows.length, data: rows });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
    next(err);
  }
};

// ─── GET /api/reports/inventory ──────────────────────────────────────────────
exports.inventoryReport = async (req, res, next) => {
  try {
    const { fromPeriod, toPeriod, subsidiaries } = extractFilters(req);
    if (!fromPeriod || !toPeriod) {
      return res.status(400).json({ success: false, error: 'fromPeriod and toPeriod are required' });
    }
    const rows = await getInventoryReport({ fromPeriod, toPeriod, subsidiaries });
    res.json({ success: true, report: 'inventory', fromPeriod, toPeriod, rowCount: rows.length, data: rows });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
    next(err);
  }
};

// ─── GET /api/reports/vat-report ─────────────────────────────────────────────
exports.vatReport = async (req, res, next) => {
  try {
    const { fromPeriod, toPeriod, subsidiaries } = extractFilters(req);
    if (!fromPeriod || !toPeriod) {
      return res.status(400).json({ success: false, error: 'fromPeriod and toPeriod are required' });
    }
    const rows = await getVatReport({ fromPeriod, toPeriod, subsidiaries });
    res.json({ success: true, report: 'vat-report', fromPeriod, toPeriod, rowCount: rows.length, data: rows });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
    next(err);
  }
};

// ─── GET /api/reports/ap-aging ───────────────────────────────────────────────
exports.apAging = async (req, res, next) => {
  try {
    const { fromPeriod, toPeriod, subsidiaries } = extractFilters(req);
    if (!fromPeriod || !toPeriod) {
      return res.status(400).json({ success: false, error: 'fromPeriod and toPeriod are required' });
    }
    const rows = await getAPAging({ fromPeriod, toPeriod, subsidiaries });
    res.json({ success: true, report: 'ap-aging', fromPeriod, toPeriod, rowCount: rows.length, data: rows });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
    next(err);
  }
};

// ─── GET /api/reports/ar-aging ───────────────────────────────────────────────
exports.arAging = async (req, res, next) => {
  try {
    const { fromPeriod, toPeriod, subsidiaries } = extractFilters(req);
    if (!fromPeriod || !toPeriod) {
      return res.status(400).json({ success: false, error: 'fromPeriod and toPeriod are required' });
    }
    const rows = await getARAging({ fromPeriod, toPeriod, subsidiaries });
    res.json({ success: true, report: 'ar-aging', fromPeriod, toPeriod, rowCount: rows.length, data: rows });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
    next(err);
  }
};

// ─── GET /api/reports/sales-by-taxcode ───────────────────────────────────────
exports.salesByTaxcode = async (req, res, next) => {
  try {
    const { fromPeriod, toPeriod, subsidiaries } = extractFilters(req);
    const rows = await getSalesByTaxcode({ fromPeriod, toPeriod, subsidiaries });
    res.json({
      success: true,
      report: 'sales-by-taxcode',
      fromPeriod: fromPeriod || null,
      toPeriod: toPeriod || null,
      rowCount: rows.length,
      data: rows,
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
    next(err);
  }
};

// ─── GET /api/reports/purchase-by-taxcode ────────────────────────────────────
exports.purchaseByTaxcode = async (req, res, next) => {
  try {
    const { fromPeriod, toPeriod, subsidiaries } = extractFilters(req);
    const rows = await getPurchaseByTaxcode({ fromPeriod, toPeriod, subsidiaries });
    res.json({
      success: true,
      report: 'purchase-by-taxcode',
      fromPeriod: fromPeriod || null,
      toPeriod: toPeriod || null,
      rowCount: rows.length,
      data: rows,
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, error: err.message });
    next(err);
  }
};
