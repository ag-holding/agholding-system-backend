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
  if (!fromPeriod || !toPeriod) throw Object.assign(new Error('Invalid period range'), { statusCode: 400 });

  // Build subsidiary filter for base_data, opening_balance, and current_data CTEs
  const subFilter = buildSubsidiaryBindings(subsidiaries);
  const subClause = subFilter ? `AND ${subFilter.clause}` : '';

  const sql = `
    WITH params AS (
      SELECT 
        ? AS from_period,
        ? AS to_period
    ),
    
    date_range AS (
      SELECT
        TO_DATE('01-' || from_period, 'DD-Mon-YY') AS start_date,
        (TO_DATE('01-' || to_period, 'DD-Mon-YY') 
          + INTERVAL '1 month' - INTERVAL '1 day') AS end_date
      FROM params
    ),
    
    base_data AS (
      SELECT
        Accounttext AS account,
        Recordtype,
        isposting AS period,
        internalid AS transaction_id,
        line_id,
        TO_DATE(trandate, 'DD-MM-YYYY') AS trandate_date,
        TO_DATE('01-' || isposting, 'DD-Mon-YY') AS period_date,
        Glsubsidiarytext,
        
        COALESCE(NULLIF(TRIM(cramount), '')::numeric, 0) AS cramount_num,
        COALESCE(NULLIF(TRIM(dramount), '')::numeric, 0) AS dramount_num
      
      FROM "GLImpact_table"
      
      WHERE Accounttext IS NOT NULL
        AND TRIM(Accounttext) <> ''
        
        /* ✅ REMOVE NON-POSTING ACCOUNTS */
        AND (
          accounttype IS NULL
          OR LOWER(TRIM(accounttype)) <> 'non posting'
        )
        
        /* ✅ REMOVE NON-GL RECORD TYPES */
        AND LOWER(TRIM(Recordtype)) NOT IN (
          'purchase order',
          'opportunity',
          'sales order',
          'estimate'
        )
    ),
    
    /* ✅ OPENING = BEFORE FROM PERIOD */
    opening_balance AS (
      SELECT
        b.account,
        SUM(b.dramount_num - b.cramount_num) AS opening_balance
      FROM base_data b
      CROSS JOIN date_range p
      WHERE b.period_date < p.start_date
        ${subClause}
      GROUP BY b.account
    ),
    
    /* ✅ CURRENT DATA */
    current_data AS (
      SELECT b.*
      FROM base_data b
      CROSS JOIN date_range p
      WHERE b.period_date BETWEEN p.start_date AND p.end_date
        ${subClause}
        AND NOT (b.cramount_num = 0 AND b.dramount_num = 0)
    ),
    
    /* ✅ TRANSACTION LEVEL */
    transaction_level AS (
      SELECT
        account,
        Recordtype,
        period,
        transaction_id,
        MIN(trandate_date) AS trandate_date,
        SUM(dramount_num) AS dramount_num,
        SUM(cramount_num) AS cramount_num
      FROM current_data
      GROUP BY
        account,
        Recordtype,
        period,
        transaction_id
    ),
    
    /* ✅ OPENING ROW */
    opening_row AS (
      SELECT
        o.account,
        'Opening Balance' AS Recordtype,
        NULL AS period,
        NULL AS transaction_id,
        NULL AS line_id,
        NULL AS trandate,
        '0' AS cramount,
        '0' AS dramount,
        COALESCE(o.opening_balance,0)::TEXT AS balance,
        -1 AS sort_order
      FROM opening_balance o
    ),
    
    /* ✅ DETAIL DATA */
    detail_data AS (
      SELECT
        t.account,
        t.Recordtype,
        t.period,
        t.transaction_id,
        NULL AS line_id,
        TO_CHAR(t.trandate_date, 'DD-MM-YYYY') AS trandate,
        
        t.cramount_num::TEXT AS cramount,
        t.dramount_num::TEXT AS dramount,
        
        (
          COALESCE(o.opening_balance, 0)
          +
          SUM(t.dramount_num - t.cramount_num) OVER (
            PARTITION BY t.account
            ORDER BY t.trandate_date, t.transaction_id
          )
        )::TEXT AS balance,
        
        0 AS sort_order
      
      FROM transaction_level t
      LEFT JOIN opening_balance o
        ON t.account = o.account
    )
    
    /* ✅ FINAL OUTPUT */
    SELECT *
    FROM (
      SELECT * FROM opening_row
      UNION ALL
      SELECT * FROM detail_data
    ) final
    
    ORDER BY 
      account,
      sort_order,
      TO_DATE(trandate, 'DD-MM-YYYY'),
      transaction_id
  `;

  const bindings = subFilter
    ? [fromPeriod, toPeriod, ...subFilter.bindings, ...subFilter.bindings]
    : [fromPeriod, toPeriod];

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
  if (!fromPeriod || !toPeriod) throw Object.assign(new Error('Invalid period range'), { statusCode: 400 });

  // Build subsidiary filter
  const subFilter = buildSubsidiaryBindings(subsidiaries);
  const subClause = subFilter ? `AND ${subFilter.clause}` : '';

  const sql = `
    WITH params AS (
      SELECT 
        ? AS from_period,
        ? AS to_period
    ),
    date_range AS (
      SELECT
        TO_DATE('01-' || from_period, 'DD-Mon-YY') AS start_date,
        (TO_DATE('01-' || to_period, 'DD-Mon-YY') 
          + INTERVAL '1 month' - INTERVAL '1 day') AS end_date
      FROM params
    ),
    base_data AS (
      SELECT
        g.Accounttext AS account,
        g.Recordtype,
        g.glentitytext AS entitytext,
        g.internalid AS transaction_id,
        TO_DATE(g.trandate, 'DD-MM-YYYY') AS trandate,
        TO_DATE('01-' || g.isposting, 'DD-Mon-YY') AS period_date,
        COALESCE(NULLIF(TRIM(g.dramount), '')::numeric, 0) AS dr,
        COALESCE(NULLIF(TRIM(g.cramount), '')::numeric, 0) AS cr
      FROM "GLImpact_table" g
      WHERE g.Accounttext IS NOT NULL
        AND TRIM(g.Accounttext) <> ''
        ${subClause}
        AND TRIM(g.accounttype) IN (
          'Bank','Accounts Receivable','Accounts Payable','Other Current Asset','Other Current Liability',
          'Fixed Asset','Other Asset','Long Term Liability','Equity',
          'Deferred Expense','Deferred Revenue','Unbilled Receivable'
        )
        AND LOWER(TRIM(g.Recordtype)) NOT IN (
          'purchase order','sales order','estimate','opportunity',
          'requisition','transfer order'
        )
        AND g.trandate IS NOT NULL
    ),
    opening_balance AS (
      SELECT
        account,
        SUM(dr - cr) AS opening_balance
      FROM base_data b
      CROSS JOIN date_range d
      WHERE b.period_date < d.start_date
      GROUP BY account
    ),
    current_data AS (
      SELECT *
      FROM base_data b
      CROSS JOIN date_range d
      WHERE b.period_date BETWEEN d.start_date AND d.end_date
    ),
    /* ── OPENING ROW for accounts that HAVE current period activity ──
       Shows the brought-forward balance as the first row per account,
       same pattern as the General Ledger SQL                          */
    opening_row AS (
      SELECT
        o.account,
        'Opening Balance'    AS Recordtype,
        NULL::TEXT           AS transaction_id,
        NULL::DATE           AS trandate,
        NULL::TEXT           AS entitytext,
        0::numeric           AS amount,
        COALESCE(o.opening_balance, 0) AS balance
      FROM opening_balance o
      WHERE o.account IN (
        SELECT DISTINCT account FROM current_data
      )
    ),
    detail_data AS (
      SELECT
        c.account,
        c.Recordtype,
        c.transaction_id,
        c.trandate,
        c.entitytext,
        (c.dr - c.cr) AS amount,
        (
          COALESCE(o.opening_balance, 0)
          +
          SUM(c.dr - c.cr) OVER (
            PARTITION BY c.account
            ORDER BY 
              c.trandate NULLS FIRST,
              c.transaction_id 
          )
        ) AS balance
      FROM current_data c
      LEFT JOIN opening_balance o
        ON c.account = o.account
    ),
    opening_only_accounts AS (
      SELECT
        o.account,
        'Opening Balance' AS Recordtype,
        NULL::TEXT AS transaction_id,
        NULL::DATE AS trandate,
        NULL::TEXT AS entitytext,
        0::numeric AS amount,
        o.opening_balance AS balance
      FROM opening_balance o
      WHERE o.account NOT IN (
        SELECT DISTINCT account FROM current_data
      )
    )
    /* ✅ FINAL OUTPUT WITH FILTER */
    SELECT *
    FROM (
      /* Opening row for accounts WITH current period activity */
      SELECT 
        account,
        Recordtype,
        transaction_id,
        trandate,
        entitytext,
        amount,
        balance
      FROM opening_row
      
      UNION ALL
      
      SELECT 
        account,
        Recordtype,
        transaction_id,
        trandate,
        entitytext,
        amount,
        balance
      FROM detail_data
      
      UNION ALL
      
      /* Opening row for accounts WITHOUT current period activity */
      SELECT 
        account,
        Recordtype,
        transaction_id,
        trandate,
        entitytext,
        amount,
        balance
      FROM opening_only_accounts
    ) final
    /* 🔥 REMOVE ZERO AMOUNT ROWS (EXCEPT OPENING) */
    WHERE NOT (
      amount = 0 
      AND Recordtype <> 'Opening Balance'
    )
    ORDER BY 
      account,
      trandate NULLS FIRST,
      transaction_id
  `;

  const bindings = subFilter ? [fromPeriod, toPeriod, ...subFilter.bindings] : [fromPeriod, toPeriod];
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
