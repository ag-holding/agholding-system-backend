const { db } = require('../config/database');
const logger = require('../utils/logger');

// ─── Period Utilities ─────────────────────────────────────────────────────────

const MONTH_ORDER = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

/**
 * Parse a period string like "jan-24" → { month: 1, year: 2024, raw: "jan-24" }
 */
function parsePeriod(str) {
  if (!str) return null;
  const clean = str.toLowerCase().trim();
  const match = clean.match(/^([a-z]{3})-(\d{2,4})$/);
  if (!match) return null;
  const month = MONTH_ORDER[match[1]];
  const year = parseInt(match[2]) < 100 ? 2000 + parseInt(match[2]) : parseInt(match[2]);
  return { month, year, raw: clean, sortKey: year * 100 + month };
}

function sortPeriods(periods) {
  return [...periods].sort((a, b) => {
    const pa = parsePeriod(a), pb = parsePeriod(b);
    if (!pa || !pb) return 0;
    return pa.sortKey - pb.sortKey;
  });
}

/**
 * Build the list of period strings between fromPeriod and toPeriod inclusive.
 */
function buildPeriodRange(fromPeriod, toPeriod) {
  const from = parsePeriod(fromPeriod);
  const to   = parsePeriod(toPeriod);
  if (!from || !to) return [];

  const result = [];
  let { month, year } = from;
  while (year < to.year || (year === to.year && month <= to.month)) {
    const m = Object.keys(MONTH_ORDER).find(k => MONTH_ORDER[k] === month);
    result.push(`${m}-${String(year).slice(-2)}`);
    month++;
    if (month > 12) { month = 1; year++; }
  }
  return result;
}

// ─── Fetch available periods from any table ────────────────────────────────

async function getAvailablePeriods(tableName = 'GLImpact_table') {
  try {
    const hasTable = await db.schema.hasTable(tableName);
    if (!hasTable) return [];

    const rows = await db(tableName)
      .distinct('isposting')
      .whereNotNull('isposting')
      .whereRaw("TRIM(isposting) <> ''");

    const periods = rows.map(r => r.isposting?.trim()).filter(Boolean);
    return sortPeriods(periods);
  } catch (err) {
    logger.error(`getAvailablePeriods error: ${err.message}`);
    return [];
  }
}

// ─── Subsidiary column check ──────────────────────────────────────────────────

async function tableHasSubsidiaryColumn(tableName) {
  try {
    const cols = await db(tableName).columnInfo();
    return Object.keys(cols).some(c => c.toLowerCase() === 'subsidiary');
  } catch { return false; }
}

// ─── Build subsidiary WHERE fragment ─────────────────────────────────────────

function buildSubsidiaryBindings(subsidiaries) {
  if (!subsidiaries || subsidiaries.length === 0) return null;
  const normalized = subsidiaries.map(s => s.trim().toLowerCase());
  const placeholders = normalized.map(() => '?').join(',');
  return { clause: `LOWER(TRIM(glsubsidiarytext)) IN (${placeholders})`, bindings: normalized };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GENERAL LEDGER
// ─────────────────────────────────────────────────────────────────────────────

async function getGeneralLedger({ fromPeriod, toPeriod, subsidiaries = [] }) {
  const periods = buildPeriodRange(fromPeriod, toPeriod);
  if (periods.length === 0) throw Object.assign(new Error('Invalid period range'), { statusCode: 400 });

  const placeholders = periods.map(() => '?').join(',');
  const subFilter = buildSubsidiaryBindings(subsidiaries);
  const subClause = subFilter ? `AND ${subFilter.clause}` : '';

  const sql = `
    WITH base AS (
      SELECT
        accounttext,
        "recordtype",
        isposting,
        internalid,
        COALESCE(NULLIF(TRIM(crfxamount::text), '')::numeric, 0) AS cr,
        COALESCE(NULLIF(TRIM(drfxamount::text), '')::numeric, 0) AS dr
      FROM "GLImpact_table"
      WHERE LOWER(TRIM(isposting)) IN (${placeholders})
        AND LOWER(TRIM("recordtype")) NOT IN ('currency revaluation', 'deliver note')
        ${subClause}
    )
    SELECT account, "recordtype", period, transaction_id,
           crfxamount, drfxamount, drfxamount - crfxamount AS balance
    FROM (
      SELECT
        accounttext AS account,
        "recordtype",
        isposting AS period,
        internalid AS transaction_id,
        SUM(cr) AS crfxamount,
        SUM(dr) AS drfxamount
      FROM base
      WHERE accounttext IS NOT NULL AND TRIM(accounttext) <> ''
      GROUP BY accounttext, "recordtype", isposting, internalid

      UNION ALL

      SELECT 'TOTAL', NULL, NULL, NULL, SUM(cr), SUM(dr)
      FROM base
    ) t
    ORDER BY
      CASE WHEN account = 'TOTAL' THEN 1 ELSE 0 END,
      transaction_id,
      account
  `;

  const bindings = subFilter
    ? [...periods, ...subFilter.bindings]
    : [...periods];

  const result = await db.raw(sql, bindings);
  return result.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. TRIAL BALANCE
// ─────────────────────────────────────────────────────────────────────────────

async function getTrialBalance({ fromPeriod, toPeriod, subsidiaries = [] }) {
  const periods = buildPeriodRange(fromPeriod, toPeriod);
  if (periods.length === 0) throw Object.assign(new Error('Invalid period range'), { statusCode: 400 });

  const placeholders = periods.map(() => '?').join(',');
  const subFilter = buildSubsidiaryBindings(subsidiaries);
  const subClause = subFilter ? `AND ${subFilter.clause}` : '';

  const sql = `
    WITH base AS (
      SELECT
        accounttext,
        COALESCE(NULLIF(TRIM(drfxamount::text), '')::numeric, 0) AS dr,
        COALESCE(NULLIF(TRIM(crfxamount::text), '')::numeric, 0) AS cr
      FROM "GLImpact_table"
      WHERE LOWER(TRIM(isposting)) IN (${placeholders})
        AND accounttext IS NOT NULL
        AND TRIM(accounttext) <> ''
        AND LOWER(TRIM("recordtype")) NOT IN ('currency revaluation', 'delivery note')
        ${subClause}
    )
    SELECT account, debit, credit
    FROM (
      SELECT
        accounttext AS account,
        SUM(dr) AS debit,
        SUM(cr) AS credit
      FROM base
      GROUP BY accounttext

      UNION ALL

      SELECT 'TOTAL', SUM(dr), SUM(cr)
      FROM base
    ) t
    ORDER BY
      CASE WHEN account = 'TOTAL' THEN 1 ELSE 0 END,
      account
  `;

  const bindings = subFilter ? [...periods, ...subFilter.bindings] : periods;
  const result = await db.raw(sql, bindings);
  return result.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. INCOME STATEMENT (P&L)
// ─────────────────────────────────────────────────────────────────────────────

async function getIncomeStatement({ fromPeriod, toPeriod, subsidiaries = [] }) {
  const periods = buildPeriodRange(fromPeriod, toPeriod);
  if (periods.length === 0) throw Object.assign(new Error('Invalid period range'), { statusCode: 400 });

  const placeholders = periods.map(() => '?').join(',');
  const subFilter = buildSubsidiaryBindings(subsidiaries);
  const subClause = subFilter ? `AND ${subFilter.clause}` : '';

  // Uses accounttype to classify Income / Expense lines
  const sql = `
    SELECT
      accounttype,
      accounttext                                                         AS account,
      SUM(COALESCE(NULLIF(TRIM(netamount::text),'')::numeric, 0))          AS net_amount
    FROM "GLImpact_table"
    WHERE LOWER(TRIM(isposting)) IN (${placeholders})
      AND LOWER(accounttype) IN ('income','other income','cost of goods sold','expense','other expense')
      AND accounttext IS NOT NULL
      AND LOWER(TRIM("recordtype")) NOT IN ('currency revaluation', 'deliver note')
      ${subClause}
    GROUP BY accounttype, accounttext
    ORDER BY
      CASE LOWER(accounttype)
        WHEN 'income'        THEN 1
        WHEN 'other income'  THEN 2
        WHEN 'cost of goods sold' THEN 3
        WHEN 'expense'       THEN 4
        WHEN 'other expense' THEN 5
        ELSE 6
      END,
      accounttext
  `;

  const bindings = subFilter ? [...periods, ...subFilter.bindings] : periods;
  const result = await db.raw(sql, bindings);
  return result.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. BALANCE SHEET
// ─────────────────────────────────────────────────────────────────────────────

async function getBalanceSheet({ fromPeriod, toPeriod, subsidiaries = [] }) {
  const periods = buildPeriodRange(fromPeriod, toPeriod);
  if (periods.length === 0) throw Object.assign(new Error('Invalid period range'), { statusCode: 400 });

  const placeholders = periods.map(() => '?').join(',');
  const subFilter = buildSubsidiaryBindings(subsidiaries);
  const subClause = subFilter ? `AND ${subFilter.clause}` : '';

  const sql = `
    SELECT
      accounttype,
      accounttext                                                         AS account,
      SUM(COALESCE(NULLIF(TRIM(endingbalance::text),'')::numeric, 0))      AS ending_balance
    FROM "GLImpact_table"
    WHERE LOWER(TRIM(isposting)) IN (${placeholders})
      AND LOWER(accounttype) IN ('bank','accounts receivable','other current asset','fixed asset',
                                 'other asset','accounts payable','credit card','other current liability',
                                 'long term liability','equity','retained earnings')
      AND accounttext IS NOT NULL
      AND LOWER(TRIM("recordtype")) NOT IN ('currency revaluation', 'deliver note')
      ${subClause}
    GROUP BY accounttype, accounttext
    ORDER BY
      CASE LOWER(accounttype)
        WHEN 'bank'                     THEN 1
        WHEN 'accounts receivable'      THEN 2
        WHEN 'other current asset'      THEN 3
        WHEN 'fixed asset'              THEN 4
        WHEN 'other asset'              THEN 5
        WHEN 'accounts payable'         THEN 6
        WHEN 'credit card'              THEN 7
        WHEN 'other current liability'  THEN 8
        WHEN 'long term liability'      THEN 9
        WHEN 'equity'                   THEN 10
        WHEN 'retained earnings'        THEN 11
        ELSE 12
      END,
      accounttext
  `;

  const bindings = subFilter ? [...periods, ...subFilter.bindings] : periods;
  const result = await db.raw(sql, bindings);
  return result.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. INVENTORY REPORT
// ─────────────────────────────────────────────────────────────────────────────

async function getInventoryReport({ fromPeriod, toPeriod, subsidiaries = [] }) {
  const periods = buildPeriodRange(fromPeriod, toPeriod);
  if (periods.length === 0) throw Object.assign(new Error('Invalid period range'), { statusCode: 400 });

  const placeholders = periods.map(() => '?').join(',');
  const subFilter = buildSubsidiaryBindings(subsidiaries);
  const subClause = subFilter ? `AND ${subFilter.clause}` : '';

  const sql = `
    SELECT
      item,
      itemtype,
      isposting                                                             AS period,
      SUM(COALESCE(NULLIF(TRIM(quantity::text),'')::numeric, 0))           AS quantity,
      SUM(COALESCE(NULLIF(TRIM(amount::text),'')::numeric, 0))             AS amount
    FROM "InventoryImpact"
    WHERE LOWER(TRIM(isposting)) IN (${placeholders})
      AND item IS NOT NULL
      ${subClause}
    GROUP BY item, itemtype, isposting
    ORDER BY item, isposting
  `;

  const bindings = subFilter ? [...periods, ...subFilter.bindings] : periods;
  const result = await db.raw(sql, bindings);
  return result.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. UAE VAT REPORT
// ─────────────────────────────────────────────────────────────────────────────

async function getVatReport({ fromPeriod, toPeriod, subsidiaries = [] }) {
  const periods = buildPeriodRange(fromPeriod, toPeriod);
  if (periods.length === 0) throw Object.assign(new Error('Invalid period range'), { statusCode: 400 });

  const placeholders = periods.map(() => '?').join(',');
  const subFilter = buildSubsidiaryBindings(subsidiaries);
  const subClause = subFilter ? `AND ${subFilter.clause}` : '';

  const sql = `
    SELECT
      isposting                                                             AS period,
      taxcode,
      taxtype,
      SUM(COALESCE(NULLIF(TRIM(taxableamount::text),'')::numeric, 0))      AS taxable_amount,
      SUM(COALESCE(NULLIF(TRIM(taxamount::text),'')::numeric, 0))          AS tax_amount
    FROM "TaxImpact"
    WHERE LOWER(TRIM(isposting)) IN (${placeholders})
      AND taxcode IS NOT NULL
      ${subClause}
    GROUP BY isposting, taxcode, taxtype
    ORDER BY isposting, taxcode
  `;

  const bindings = subFilter ? [...periods, ...subFilter.bindings] : periods;
  const result = await db.raw(sql, bindings);
  return result.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. ACCOUNTS PAYABLE AGING
// ─────────────────────────────────────────────────────────────────────────────

async function getAPAging({ fromPeriod, toPeriod, subsidiaries = [] }) {
  const periods = buildPeriodRange(fromPeriod, toPeriod);
  if (periods.length === 0) throw Object.assign(new Error('Invalid period range'), { statusCode: 400 });

  const placeholders = periods.map(() => '?').join(',');
  const subFilter = buildSubsidiaryBindings(subsidiaries);
  const subClause = subFilter ? `AND ${subFilter.clause}` : '';

  const sql = `
    SELECT
      entity                                                                AS vendor,
      internalid                                                            AS transaction_id,
      trandate                                                              AS transaction_date,
      duedate,
      isposting                                                             AS period,
      COALESCE(NULLIF(TRIM(amount::text),'')::numeric, 0)                  AS amount,
      CASE
        WHEN duedate IS NOT NULL AND CURRENT_DATE - duedate::date <= 0   THEN 'Current'
        WHEN duedate IS NOT NULL AND CURRENT_DATE - duedate::date <= 30  THEN '1-30 days'
        WHEN duedate IS NOT NULL AND CURRENT_DATE - duedate::date <= 60  THEN '31-60 days'
        WHEN duedate IS NOT NULL AND CURRENT_DATE - duedate::date <= 90  THEN '61-90 days'
        ELSE 'Over 90 days'
      END                                                                   AS aging_bucket
    FROM "APTransaction"
    WHERE LOWER(TRIM(isposting)) IN (${placeholders})
      AND entity IS NOT NULL
      AND LOWER(TRIM(status)) = 'open'
      ${subClause}
    ORDER BY entity, duedate
  `;

  const bindings = subFilter ? [...periods, ...subFilter.bindings] : periods;
  const result = await db.raw(sql, bindings);
  return result.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. ACCOUNTS RECEIVABLE AGING
// ─────────────────────────────────────────────────────────────────────────────

async function getARAging({ fromPeriod, toPeriod, subsidiaries = [] }) {
  const periods = buildPeriodRange(fromPeriod, toPeriod);
  if (periods.length === 0) throw Object.assign(new Error('Invalid period range'), { statusCode: 400 });

  const placeholders = periods.map(() => '?').join(',');
  const subFilter = buildSubsidiaryBindings(subsidiaries);
  const subClause = subFilter ? `AND ${subFilter.clause}` : '';

  const sql = `
    SELECT
      entity                                                                AS customer,
      internalid                                                            AS transaction_id,
      trandate                                                              AS transaction_date,
      duedate,
      isposting                                                             AS period,
      COALESCE(NULLIF(TRIM(amount::text),'')::numeric, 0)                  AS amount,
      CASE
        WHEN duedate IS NOT NULL AND CURRENT_DATE - duedate::date <= 0   THEN 'Current'
        WHEN duedate IS NOT NULL AND CURRENT_DATE - duedate::date <= 30  THEN '1-30 days'
        WHEN duedate IS NOT NULL AND CURRENT_DATE - duedate::date <= 60  THEN '31-60 days'
        WHEN duedate IS NOT NULL AND CURRENT_DATE - duedate::date <= 90  THEN '61-90 days'
        ELSE 'Over 90 days'
      END                                                                   AS aging_bucket
    FROM "ARTransaction"
    WHERE LOWER(TRIM(isposting)) IN (${placeholders})
      AND entity IS NOT NULL
      AND LOWER(TRIM(status)) = 'open'
      ${subClause}
    ORDER BY entity, duedate
  `;

  const bindings = subFilter ? [...periods, ...subFilter.bindings] : periods;
  const result = await db.raw(sql, bindings);
  return result.rows;
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getAvailablePeriods,
  getGeneralLedger,
  getTrialBalance,
  getIncomeStatement,
  getBalanceSheet,
  getInventoryReport,
  getVatReport,
  getAPAging,
  getARAging,
  buildPeriodRange,
  sortPeriods,
};
