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
  const periods = buildTransactionPeriods(fromPeriod, toPeriod);
  if (periods.length === 0) throw Object.assign(new Error('Invalid period range'), { statusCode: 400 });

  const placeholders = periods.map(() => '?').join(',');

  // Transaction tables use "subsidiary" column, not "glsubsidiarytext"
  let subClause = '';
  let subBindings = [];
  if (subsidiaries && subsidiaries.length > 0) {
    const normalized = subsidiaries.map(s => s.trim().toLowerCase());
    const subPlaceholders = normalized.map(() => '?').join(',');
    subClause = `AND LOWER(TRIM(subsidiary)) IN (${subPlaceholders})`;
    subBindings = normalized;
  }

  // Each source table needs its own copy of period + subsidiary bindings
  const singleBindings = [...periods, ...subBindings];
  const bindings = [
    ...singleBindings, // vendorbill
    ...singleBindings, // vendorcredit
    ...singleBindings, // vendorpayment
    ...singleBindings, // deposit
  ];

  const sql = `
    WITH trx AS (
      -- Bill (positive balance)
      SELECT
        b.internalid,
        'Bill' AS recordtype,
        b.tranid,
        b.trandate,
        b.duedate,
        COALESCE(NULLIF(TRIM(b.name), ''), 'No Vendor') AS vendor_name,
        COALESCE(NULLIF(TRIM(b.total), '')::numeric, 0) AS open_balance
      FROM vendorbill b
      WHERE LOWER(TRIM(b."postingperiod")) IN (${placeholders})
        ${subClause}

      UNION ALL

      -- Vendor Credit (negative balance)
      SELECT
        bc.internalid,
        'Vendor Credit' AS recordtype,
        bc.tranid,
        bc.trandate,
        bc.trandate AS duedate,
        COALESCE(NULLIF(TRIM(bc.name), ''), 'No Vendor') AS vendor_name,
        -COALESCE(NULLIF(TRIM(bc.total), '')::numeric, 0) AS open_balance
      FROM vendorcredit bc
      WHERE LOWER(TRIM(bc."postingperiod")) IN (${placeholders})
        ${subClause}

      UNION ALL

      -- Vendor Payment (negative balance)
      SELECT
        vp.internalid,
        'Vendor Payment' AS recordtype,
        vp.tranid,
        vp.trandate,
        vp.trandate AS duedate,
        COALESCE(NULLIF(TRIM(vp.name), ''), 'No Vendor') AS vendor_name,
        -COALESCE(NULLIF(TRIM(vp.total), '')::numeric, 0) AS open_balance
      FROM vendorpayment vp
      WHERE LOWER(TRIM(vp."postingperiod")) IN (${placeholders})
        ${subClause}

      UNION ALL

      -- Deposit (negative balance)
      SELECT
        d.internalid,
        'Deposit' AS recordtype,
        d.tranid,
        d.trandate,
        d.trandate AS duedate,
        COALESCE(NULLIF(TRIM(d.name), ''), 'No Vendor') AS vendor_name,
        -COALESCE(NULLIF(TRIM(d.total), '')::numeric, 0) AS open_balance
      FROM deposit d
      WHERE LOWER(TRIM(d."postingperiod")) IN (${placeholders})
        ${subClause}
    ),

    filtered AS (
      SELECT * FROM trx
      WHERE ABS(open_balance) > 0.01
    ),

    aged AS (
      SELECT
        *,
        CURRENT_DATE - COALESCE(
          TO_DATE(NULLIF(TRIM(duedate), ''), 'DD/MM/YYYY'),
          CURRENT_DATE
        ) AS age,
        CASE
          WHEN CURRENT_DATE - COALESCE(TO_DATE(NULLIF(TRIM(duedate), ''), 'DD/MM/YYYY'), CURRENT_DATE) <= 30 THEN '0-30'
          WHEN CURRENT_DATE - COALESCE(TO_DATE(NULLIF(TRIM(duedate), ''), 'DD/MM/YYYY'), CURRENT_DATE) <= 60 THEN '31-60'
          WHEN CURRENT_DATE - COALESCE(TO_DATE(NULLIF(TRIM(duedate), ''), 'DD/MM/YYYY'), CURRENT_DATE) <= 90 THEN '61-90'
          ELSE '90+'
        END AS aging_bucket
      FROM filtered
    )

    SELECT
      vendor_name,
      internalid,
      recordtype,
      trandate,
      tranid,
      duedate,
      open_balance,
      age,
      aging_bucket
    FROM aged
    ORDER BY vendor_name, trandate
  `;

  const result = await db.raw(sql, bindings);
  return result.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. ACCOUNTS RECEIVABLE AGING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build period strings in "mon yyyy" format (e.g. "oct 2022") for transaction tables
 * whose Postingperiod column uses that format instead of "mon-yy".
 */
function buildTransactionPeriods(fromPeriod, toPeriod) {
  const from = parsePeriod(fromPeriod);
  const to   = parsePeriod(toPeriod);
  if (!from || !to) return [];

  const result = [];
  let { month, year } = from;
  while (year < to.year || (year === to.year && month <= to.month)) {
    const m = Object.keys(MONTH_ORDER).find(k => MONTH_ORDER[k] === month);
    result.push(`${m} ${year}`);
    month++;
    if (month > 12) { month = 1; year++; }
  }
  return result;
}

async function getARAging({ fromPeriod, toPeriod, subsidiaries = [] }) {
  const periods = buildTransactionPeriods(fromPeriod, toPeriod);
  if (periods.length === 0) throw Object.assign(new Error('Invalid period range'), { statusCode: 400 });

  const placeholders = periods.map(() => '?').join(',');

  // Transaction tables use "subsidiary" column, not "glsubsidiarytext"
  let subClause = '';
  let subBindings = [];
  if (subsidiaries && subsidiaries.length > 0) {
    const normalized = subsidiaries.map(s => s.trim().toLowerCase());
    const subPlaceholders = normalized.map(() => '?').join(',');
    subClause = `AND LOWER(TRIM(subsidiary)) IN (${subPlaceholders})`;
    subBindings = normalized;
  }

  // Each source table needs its own copy of period + subsidiary bindings
  const singleBindings = [...periods, ...subBindings];
  const bindings = [
    ...singleBindings, // invoice
    ...singleBindings, // creditmemo
    ...singleBindings, // customerpayment
    ...singleBindings, // check
    ...singleBindings, // deposit
  ];

  const sql = `
    WITH trx AS (
      -- Invoice (positive balance)
      SELECT
        i.internalid,
        'Invoice' AS recordtype,
        i.tranid,
        i.trandate,
        i.duedate,
        COALESCE(NULLIF(TRIM(i.name), ''), 'No Customer/Project') AS customer_name,
        COALESCE(NULLIF(TRIM(i.total), '')::numeric, 0) AS open_balance
      FROM invoice i
      WHERE LOWER(TRIM(i."postingperiod")) IN (${placeholders})
        ${subClause}

      UNION ALL

      -- Credit Memo (negative balance)
      SELECT
        cm.internalid,
        'Credit Memo' AS recordtype,
        cm.tranid,
        cm.trandate,
        cm.trandate AS duedate,
        COALESCE(NULLIF(TRIM(cm.name), ''), 'No Customer/Project') AS customer_name,
        -COALESCE(NULLIF(TRIM(cm.total), '')::numeric, 0) AS open_balance
      FROM creditmemo cm
      WHERE LOWER(TRIM(cm."postingperiod")) IN (${placeholders})
        ${subClause}

      UNION ALL

      -- Customer Payment (negative balance)
      SELECT
        cp.internalid,
        'Payment' AS recordtype,
        cp.tranid,
        cp.trandate,
        cp.trandate AS duedate,
        COALESCE(NULLIF(TRIM(cp.name), ''), 'No Customer/Project') AS customer_name,
        -COALESCE(NULLIF(TRIM(cp.total), '')::numeric, 0) AS open_balance
      FROM customerpayment cp
      WHERE LOWER(TRIM(cp."postingperiod")) IN (${placeholders})
        ${subClause}

      UNION ALL

      -- Check (negative balance)
      SELECT
        ch.internalid,
        'Check' AS recordtype,
        ch.tranid,
        ch.trandate,
        ch.trandate AS duedate,
        COALESCE(NULLIF(TRIM(ch.name), ''), 'No Customer/Project') AS customer_name,
        -COALESCE(NULLIF(TRIM(ch.total), '')::numeric, 0) AS open_balance
      FROM "check" ch
      WHERE LOWER(TRIM(ch."postingperiod")) IN (${placeholders})
        ${subClause}

      UNION ALL

      -- Deposit (negative balance)
      SELECT
        d.internalid,
        'Deposit' AS recordtype,
        d.tranid,
        d.trandate,
        d.trandate AS duedate,
        COALESCE(NULLIF(TRIM(d.name), ''), 'No Customer/Project') AS customer_name,
        -COALESCE(NULLIF(TRIM(d.total), '')::numeric, 0) AS open_balance
      FROM deposit d
      WHERE LOWER(TRIM(d."postingperiod")) IN (${placeholders})
        ${subClause}
    ),

    filtered AS (
      SELECT * FROM trx
      WHERE ABS(open_balance) > 0.01
    ),

    aged AS (
      SELECT
        *,
        CURRENT_DATE - COALESCE(
          TO_DATE(NULLIF(TRIM(duedate), ''), 'DD/MM/YYYY'),
          CURRENT_DATE
        ) AS age,
        CASE
          WHEN CURRENT_DATE - COALESCE(TO_DATE(NULLIF(TRIM(duedate), ''), 'DD/MM/YYYY'), CURRENT_DATE) <= 30 THEN '0-30'
          WHEN CURRENT_DATE - COALESCE(TO_DATE(NULLIF(TRIM(duedate), ''), 'DD/MM/YYYY'), CURRENT_DATE) <= 60 THEN '31-60'
          WHEN CURRENT_DATE - COALESCE(TO_DATE(NULLIF(TRIM(duedate), ''), 'DD/MM/YYYY'), CURRENT_DATE) <= 90 THEN '61-90'
          ELSE '90+'
        END AS aging_bucket
      FROM filtered
    )

    SELECT
      internalid,
      customer_name,
      recordtype,
      trandate,
      tranid,
      duedate,
      open_balance,
      age,
      aging_bucket
    FROM aged
    ORDER BY customer_name, trandate
  `;

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
