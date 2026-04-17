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

  const sql = `
    WITH detail_data AS (
      SELECT
        g.internalid,
        g.accounttext AS account,
        g.accounttype AS account_type,
        MIN(g.recordtype) AS recordtype,
        CASE
          WHEN g.accounttype IN ('Income','Other Income') THEN 'Income'
          WHEN g.accounttype IN ('Cost of Goods Sold') THEN 'COGS'
          WHEN g.accounttype IN ('Expense','Other Expense') THEN 'Expenses'
        END AS category,
        SUM(COALESCE(NULLIF(TRIM(g.drfxamount), '')::numeric, 0)) AS dr,
        SUM(COALESCE(NULLIF(TRIM(g.crfxamount), '')::numeric, 0)) AS cr
      FROM "GLImpact_table" g
      WHERE LOWER(TRIM(g.isposting)) IN (${placeholders})
        AND g.accounttext IS NOT NULL
        AND TRIM(g.accounttext) <> ''
        AND LOWER(TRIM(g.recordtype)) NOT IN ('currency revaluation', 'delivery note')
        AND g.accounttype IN (
          'Income','Other Income',
          'Cost of Goods Sold',
          'Expense','Other Expense'
        )
        ${subClause}
      GROUP BY g.internalid, g.accounttext, g.accounttype
    ),
    pl_data AS (
      SELECT
        internalid, recordtype, category, account, account_type,
        CASE
          WHEN category = 'Income' THEN cr - dr
          WHEN category = 'COGS' THEN dr - cr
          WHEN category = 'Expenses' THEN dr - cr
        END AS amount
      FROM detail_data
    ),
    final AS (
      SELECT internalid, recordtype, category, account, account_type, amount, 1 AS sort_order
      FROM pl_data
      UNION ALL
      SELECT NULL, NULL, category, 'Total ' || category, NULL, ABS(SUM(amount)), 2
      FROM pl_data
      GROUP BY category
      UNION ALL
      SELECT NULL, NULL, 'Net', 'Net Income', NULL, SUM(amount), 3
      FROM pl_data
    )
    SELECT internalid, recordtype, category, account, account_type, amount
    FROM final
    ORDER BY
      CASE category
        WHEN 'Income' THEN 1
        WHEN 'COGS' THEN 2
        WHEN 'Expenses' THEN 3
        WHEN 'Net' THEN 4
      END,
      sort_order,
      account
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
    WITH detail_data AS (
      SELECT
        g.internalid,
        g.accounttext AS account,
        g.accounttype AS account_type,
        MIN(g.recordtype) AS recordtype,
        CASE
          WHEN g.accounttype IN (
            'Bank','Accounts Receivable','Other Current Asset',
            'Fixed Asset','Other Asset'
          ) THEN 'Assets'
          WHEN g.accounttype IN (
            'Accounts Payable','Credit Card',
            'Other Current Liability','Long Term Liability'
          ) THEN 'Liabilities'
          WHEN g.accounttype = 'Equity' THEN 'Equity'
        END AS category,
        SUM(COALESCE(NULLIF(TRIM(g.drfxamount), '')::numeric, 0)) AS dr,
        SUM(COALESCE(NULLIF(TRIM(g.crfxamount), '')::numeric, 0)) AS cr
      FROM "GLImpact_table" g
      WHERE LOWER(TRIM(g.isposting)) IN (${placeholders})
        AND g.accounttext IS NOT NULL
        AND TRIM(g.accounttext) <> ''
        AND LOWER(TRIM(g.recordtype)) NOT IN ('currency revaluation', 'delivery note')
        AND g.accounttype IN (
          'Bank','Accounts Receivable','Other Current Asset',
          'Fixed Asset','Other Asset',
          'Accounts Payable','Credit Card',
          'Other Current Liability','Long Term Liability',
          'Equity'
        )
        ${subClause}
      GROUP BY g.internalid, g.accounttext, g.accounttype
    ),
    non_equity AS (
      SELECT
        internalid, recordtype, category, account, account_type,
        CASE
          WHEN category = 'Assets' THEN dr - cr
          ELSE cr - dr
        END AS amount
      FROM detail_data
      WHERE category <> 'Equity'
    ),
    equity_split AS (
      SELECT internalid, recordtype, category, account, account_type, -dr AS amount
      FROM detail_data
      WHERE category = 'Equity' AND dr <> 0
      UNION ALL
      SELECT internalid, recordtype, category, account, account_type, cr AS amount
      FROM detail_data
      WHERE category = 'Equity' AND cr <> 0
    ),
    all_data AS (
      SELECT * FROM non_equity
      UNION ALL
      SELECT * FROM equity_split
    ),
    final AS (
      SELECT internalid, recordtype, category, account, account_type, amount, 1 AS sort_order
      FROM all_data
      UNION ALL
      SELECT NULL, NULL, category, 'Total ' || category, NULL, ABS(SUM(amount)), 2
      FROM all_data
      GROUP BY category
    )
    SELECT internalid, recordtype, category, account, account_type, amount
    FROM final
    ORDER BY
      CASE category
        WHEN 'Assets' THEN 1
        WHEN 'Liabilities' THEN 2
        WHEN 'Equity' THEN 3
      END,
      sort_order,
      account
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
