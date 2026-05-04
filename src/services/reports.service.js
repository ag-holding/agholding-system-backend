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
        ? AS from_period,   -- 🔥 USER INPUT
        ? AS to_period      -- 🔥 USER INPUT
    ),
    
    date_range AS (
      SELECT
        TO_DATE('01-' || from_period, 'DD-Mon-YY')                        AS start_date,
        (TO_DATE('01-' || to_period,  'DD-Mon-YY')
            + INTERVAL '1 month' - INTERVAL '1 day')                      AS end_date
      FROM params
    ),
    
    base_data AS (
      SELECT
        g.Accounttext                                                      AS account,
        g.accounttype,
        g.Recordtype,
        g.isposting                                                        AS period,
        g.internalid                                                       AS transaction_id,
        g.line_id,
        
        /* trandate_date  — used for detail row ordering and display      */
        TO_DATE(g.trandate, 'DD-MM-YYYY')                                 AS trandate_date,
        
        /* period_date   — used for ALL date-range filtering.
           This matches NetSuite's posting period (isposting field),
           which is what the Custom GL / Trial Balance report uses.
           ⚠️  Do NOT use trandate for period filtering — some journal
           entries have trandate in a different month than isposting.     */
        TO_DATE('01-' || g.isposting, 'DD-Mon-YY')                       AS period_date,
        
        g.Glsubsidiarytext,
        COALESCE(NULLIF(TRIM(g.cramount), '')::NUMERIC, 0)                AS cramount_num,
        COALESCE(NULLIF(TRIM(g.dramount), '')::NUMERIC, 0)                AS dramount_num
      
      FROM "GLImpact_table" g
      
      WHERE g.Accounttext IS NOT NULL
        AND TRIM(g.Accounttext) <> ''
        
        /* ── Exclude NonPosting account types ────────────────────────
           Estimates, PO, SO, Opportunities etc. have accounttype =
           'NonPosting' in the chart of accounts. Exclude at source.     */
        AND (
            g.accounttype IS NULL
            OR LOWER(TRIM(g.accounttype)) <> 'nonposting'
        )
        
        /* ── Exclude non-GL record types ─────────────────────────────
           Belt-and-suspenders safety net on top of accounttype filter.  */
        AND LOWER(TRIM(g.Recordtype)) NOT IN (
            'purchase order',
            'opportunity',
            'sales order',
            'estimate',
            'requisition',
            'transfer order'
        )
    ),
    
    /* ── OPENING BALANCE ────────────────────────────────────────────
       FIX 1 + FIX 2 both applied here.
    
       P&L account types (Income / COGS / Expense / OthIncome /
       OthExpense) → opening always 0. These are period-only accounts
       that reset at the start of each accounting year (Jan 1).
    
       All other account types (Balance Sheet: AcctRec, AcctPay, Bank,
       OthCurrAsset, OthCurrLiab, FixedAsset, OthAsset, Equity,
       LongTermLiab, etc.) → cumulative DR-CR before the period start.
       This includes Prepaid rent (OthAsset) and similar BS accounts.
    
       period_date (isposting) is used — NOT trandate — so the split
       matches NetSuite Custom GL exactly.
       ─────────────────────────────────────────────────────────────── */
    opening_balance AS (
      SELECT
        b.account,
        CASE
            WHEN TRIM(b.accounttype) IN (
                'Income',
                'COGS',
                'Expense',
                'OthIncome',
                'OthExpense'
            )
            THEN 0  -- P&L: opening always zero
    
            ELSE SUM(b.dramount_num - b.cramount_num)  -- BS: carry forward
        END AS opening_balance
      
      FROM base_data b
      CROSS JOIN date_range p
      
      WHERE b.period_date < p.start_date
        ${subClause}
      
      GROUP BY b.account, b.accounttype
    ),
    
    /* ── CURRENT PERIOD TRANSACTIONS ─────────────────────────────── */
    current_data AS (
      SELECT b.*
      FROM base_data b
      CROSS JOIN date_range p
      WHERE b.period_date BETWEEN p.start_date AND p.end_date
        ${subClause}
        AND NOT (b.cramount_num = 0 AND b.dramount_num = 0)
    ),
    
    /* ── TRANSACTION LEVEL ───────────────────────────────────────── */
    transaction_level AS (
      SELECT
        account,
        Recordtype,
        period,
        transaction_id,
        MIN(trandate_date)  AS trandate_date,
        SUM(dramount_num)   AS dramount_num,
        SUM(cramount_num)   AS cramount_num
      FROM current_data
      GROUP BY
        account,
        Recordtype,
        period,
        transaction_id
    ),
    
    /* ── OPENING ROW ─────────────────────────────────────────────── */
    opening_row AS (
      SELECT
        o.account,
        'Opening Balance'                    AS Recordtype,
        NULL                                 AS period,
        NULL                                 AS transaction_id,
        NULL                                 AS line_id,
        NULL                                 AS trandate,
        '0'                                  AS cramount,
        '0'                                  AS dramount,
        COALESCE(o.opening_balance, 0)::TEXT AS balance,
        -1                                   AS sort_order
      FROM opening_balance o
      
      /* FIX 3: Only emit opening row for accounts with current-period
         activity. Prevents stray 0-opening rows for P&L accounts that
         had prior-year history but no current-period transactions.       */
      WHERE o.account IN (SELECT DISTINCT account FROM current_data)
    ),
    
    /* ── DETAIL ROWS ─────────────────────────────────────────────── */
    detail_data AS (
      SELECT
        t.account,
        t.Recordtype,
        t.period,
        t.transaction_id,
        NULL                                       AS line_id,
        TO_CHAR(t.trandate_date, 'DD-MM-YYYY')    AS trandate,
        t.cramount_num::TEXT                       AS cramount,
        t.dramount_num::TEXT                       AS dramount,
        
        /* Running balance per account.
           Ordered by trandate_date within period so the balance
           progression makes sense in the detail view.
           The STARTING point is the opening_balance (which itself
           uses period_date/isposting for its boundary, matching NS). */
        (
            COALESCE(o.opening_balance, 0)
            +
            SUM(t.dramount_num - t.cramount_num) OVER (
                PARTITION BY t.account
                ORDER BY t.trandate_date, t.transaction_id
            )
        )::TEXT                                    AS balance,
        
        0                                          AS sort_order
      
      FROM transaction_level t
      LEFT JOIN opening_balance o
        ON t.account = o.account
    )
    
    /* ── FINAL OUTPUT ────────────────────────────────────────────── */
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
  if (!fromPeriod || !toPeriod) throw Object.assign(new Error('Invalid period range'), { statusCode: 400 });

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
        TO_DATE('01-' || isposting, 'DD-Mon-YY') AS period_date,
        Glsubsidiarytext,
        
        COALESCE(NULLIF(TRIM(cramount), '')::numeric, 0) AS cramount,
        COALESCE(NULLIF(TRIM(dramount), '')::numeric, 0) AS dramount
      
      FROM "GLImpact_table"
      
      WHERE Accounttext IS NOT NULL
        AND TRIM(Accounttext) <> ''
        
        AND (
          accounttype IS NULL
          OR LOWER(TRIM(accounttype)) <> 'non posting'
        )
        
        /* ✅ Exclude non-GL record types */
        AND LOWER(TRIM(Recordtype)) NOT IN (
          'purchase order',
          'opportunity',
          'sales order',
          'estimate'
        )
    ),
    
    trial_balance AS (
      SELECT
        b.account,
        
        /* ✅ OPENING (before period) */
        SUM(
          CASE
            WHEN b.period_date < p.start_date
            THEN b.dramount - b.cramount
            ELSE 0
          END
        ) AS opening_balance,
        
        /* ✅ PERIOD MOVEMENT */
        SUM(
          CASE
            WHEN b.period_date BETWEEN p.start_date AND p.end_date
            THEN b.dramount - b.cramount
            ELSE 0
          END
        ) AS period_balance
      
      FROM base_data b
      CROSS JOIN date_range p
      
      WHERE TRIM(b.Glsubsidiarytext) = 'AG Holding : AGBL Group : Alliance Global FZ-LLC'
        ${subClause}
      
      GROUP BY b.account
    )
    
    SELECT
      account,
      
      CASE 
        WHEN (opening_balance + period_balance) > 0 
        THEN (opening_balance + period_balance)
        ELSE 0
      END AS debit,
      
      CASE 
        WHEN (opening_balance + period_balance) < 0 
        THEN ABS(opening_balance + period_balance)
        ELSE 0
      END AS credit
    
    FROM trial_balance
    
    WHERE (opening_balance + period_balance) <> 0
    
    ORDER BY account
  `;

  const bindings = subFilter 
    ? [fromPeriod, toPeriod, ...subFilter.bindings] 
    : [fromPeriod, toPeriod];
  
  const result = await db.raw(sql, bindings);
  return result.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. INCOME STATEMENT (P&L)
// ─────────────────────────────────────────────────────────────────────────────

async function getIncomeStatement({ fromPeriod, toPeriod, subsidiaries = [] }) {
  if (!fromPeriod || !toPeriod) throw Object.assign(new Error('Invalid period range'), { statusCode: 400 });

  // Build subsidiary filter
  const subFilter = buildSubsidiaryBindings(subsidiaries);
  const subClause = subFilter ? `AND ${subFilter.clause}` : '';

  const sql = `
    WITH params AS (
      SELECT
        ? AS from_period,   -- 🔥 USER INPUT
        ? AS to_period      -- 🔥 USER INPUT
    ),
    
    date_range AS (
      SELECT
        TO_DATE('01-' || from_period, 'DD-Mon-YY')                        AS start_date,
        (TO_DATE('01-' || to_period,  'DD-Mon-YY')
          + INTERVAL '1 month' - INTERVAL '1 day')                      AS end_date
      FROM params
    ),
    
    base_data AS (
      SELECT
        g.Accounttext                                                      AS account,
        g.accounttype,
        g.Recordtype,
        g.glentitytext                                                     AS entitytext,
        g.internalid                                                       AS transaction_id,
    
        TO_DATE(g.trandate, 'DD-MM-YYYY')                                 AS trandate,
    
        TO_DATE('01-' || g.isposting, 'DD-Mon-YY')                       AS period_date,
    
        COALESCE(NULLIF(TRIM(g.dramount), '')::NUMERIC, 0)                AS dr,
        COALESCE(NULLIF(TRIM(g.cramount), '')::NUMERIC, 0)                AS cr
    
      FROM "GLImpact_table" g
    
      WHERE g.Accounttext IS NOT NULL
        AND TRIM(g.Accounttext) <> ''
        ${subClause}
    
        AND TRIM(g.accounttype) IN (
          'Income',
          'COGS',
          'Expense',
          'OthIncome',
          'OthExpense'
        )
    
        AND LOWER(TRIM(g.Recordtype)) NOT IN (
          'purchase order',
          'sales order',
          'estimate',
          'opportunity',
          'requisition',
          'transfer order'
        )
    
        AND g.trandate IS NOT NULL
    ),
    
    current_data AS (
      SELECT b.*
      FROM base_data b
      CROSS JOIN date_range d
      WHERE b.period_date BETWEEN d.start_date AND d.end_date
    ),
    
    transaction_level AS (
      SELECT
        account,
        accounttype,
        Recordtype,
        entitytext,
        transaction_id,
        MIN(trandate)   AS trandate,
        SUM(dr)         AS dr,
        SUM(cr)         AS cr
      FROM current_data
      GROUP BY
        account,
        accounttype,
        Recordtype,
        entitytext,
        transaction_id
    ),
    
    detail_data AS (
      SELECT
        t.account,
    
        CASE
          WHEN TRIM(t.accounttype) = 'Income'     THEN '1 - Sales'
          WHEN TRIM(t.accounttype) = 'COGS'       THEN '2 - Cost of Sales'
          WHEN TRIM(t.accounttype) = 'Expense'    THEN '3 - Overheads'
          WHEN TRIM(t.accounttype) = 'OthIncome'  THEN '4 - Other Income'
          WHEN TRIM(t.accounttype) = 'OthExpense' THEN '5 - Other Expenses'
        END                                                                AS account_section,
    
        t.Recordtype,
        t.entitytext,
        t.transaction_id,
        t.trandate,
    
        /* NET AMOUNT per transaction
           Income / OthIncome  : CR - DR  (credit = positive income)
           COGS / Expense / OthExpense : DR - CR  (debit = positive cost)
           Matches NetSuite Amount column exactly                         */
        CASE
          WHEN TRIM(t.accounttype) IN ('Income', 'OthIncome')
          THEN t.cr - t.dr
          ELSE t.dr - t.cr
        END                                                                AS amount
    
      FROM transaction_level t
    )
    
    SELECT
      account,
      account_section,
      Recordtype,
      entitytext,
      transaction_id,
      trandate,
      amount
    FROM detail_data
    
    WHERE amount <> 0
    
    ORDER BY
      account_section,
      account,
      trandate NULLS FIRST,
      transaction_id
  `;

  const bindings = subFilter ? [fromPeriod, toPeriod, ...subFilter.bindings] : [fromPeriod, toPeriod];
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
  if (!fromPeriod || !toPeriod) throw Object.assign(new Error('Invalid period range'), { statusCode: 400 });

  // Build subsidiary filter if needed
  let subClause = '';
  let subBindings = [];
  if (subsidiaries && subsidiaries.length > 0) {
    const normalized = subsidiaries.map(s => s.trim().toLowerCase());
    const subPlaceholders = normalized.map(() => '?').join(',');
    subClause = `AND LOWER(TRIM(ap.subsidiary)) IN (${subPlaceholders})`;
    subBindings = normalized;
  }

  const bindings = [fromPeriod, toPeriod, ...subBindings];

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
    
    base AS (
      SELECT
        ap.name                                              AS vendor_name,
        ap.type                                              AS record_type,
        ap.document_number,
        TO_DATE(TRIM(ap.transaction_date), 'DD-MM-YYYY')     AS bill_date,
        TO_DATE(TRIM(ap.due_date), 'DD-MM-YYYY')             AS due_date,
        ap.period,
        ap.currency,
        ap.status,
 
        /* Open Balance (Foreign Currency like NetSuite Aging) */
        COALESCE(NULLIF(TRIM(ap.amount_remaining_foreign), '')::NUMERIC, 0) 
                                                             AS open_balance,
 
        /* Age Calculation */
        CASE
          WHEN NULLIF(TRIM(ap.due_date), '') IS NULL THEN 0
          ELSE (
            CURRENT_DATE 
            - TO_DATE(TRIM(ap.due_date), 'DD-MM-YYYY')
          )::INT
        END                                                  AS age
 
      FROM "_aging_a_p_data" ap
      CROSS JOIN date_range d
      WHERE TO_DATE(TRIM(ap.transaction_date), 'DD-MM-YYYY') BETWEEN d.start_date AND d.end_date
        ${subClause}
        AND COALESCE(NULLIF(TRIM(ap.amount_remaining_foreign), '')::NUMERIC, 0) > 0.01
    ),
 
    final AS (
      SELECT
        *,
        CASE
          WHEN age <= 0 THEN 'Current'
          WHEN age <= 30 THEN '1-30'
          WHEN age <= 60 THEN '31-60'
          WHEN age <= 90 THEN '61-90'
          ELSE '90+'
        END AS aging_bucket
      FROM base
    )
 
    SELECT
      vendor_name,
      record_type,
      document_number,
      bill_date,
      due_date,
      period,
      currency,
      status,
      open_balance,
      age,
      aging_bucket
    FROM final
    ORDER BY vendor_name, bill_date
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
  if (!fromPeriod || !toPeriod) throw Object.assign(new Error('Invalid period range'), { statusCode: 400 });

  // Build subsidiary filter if needed
  let subClause = '';
  let subBindings = [];
  if (subsidiaries && subsidiaries.length > 0) {
    const normalized = subsidiaries.map(s => s.trim().toLowerCase());
    const subPlaceholders = normalized.map(() => '?').join(',');
    subClause = `AND LOWER(TRIM(ar.subsidiary)) IN (${subPlaceholders})`;
    subBindings = normalized;
  }

  const bindings = [fromPeriod, toPeriod, ...subBindings];

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
    
    base AS (
      SELECT
        ar.name                                              AS customer_name,
        ar.type                                              AS record_type,
        ar.document_number,
        TO_DATE(TRIM(ar.transaction_date), 'DD-MM-YYYY')     AS invoice_date,
        TO_DATE(TRIM(ar.due_date), 'DD-MM-YYYY')             AS due_date,
        ar.period,
        ar.currency,
        ar.status,
 
        /* Open Balance (Foreign Currency - NetSuite Standard)
           Handles parentheses notation for negative values */
        CASE
          WHEN TRIM(ar.amount_remaining_foreign) LIKE '(%)'
          THEN -REPLACE(REPLACE(TRIM(ar.amount_remaining_foreign), '(', ''), ')', '')::NUMERIC
          ELSE COALESCE(NULLIF(TRIM(ar.amount_remaining_foreign), '')::NUMERIC, 0)
        END                                                   AS open_balance,
 
        /* Age Calculation */
        CASE
          WHEN NULLIF(TRIM(ar.due_date), '') IS NULL THEN 0
          ELSE (
            CURRENT_DATE
            - TO_DATE(TRIM(ar.due_date), 'DD-MM-YYYY')
          )::INT
        END                                                   AS age
 
      FROM "aging_r_a_data" ar
      CROSS JOIN date_range d
      WHERE TO_DATE(TRIM(ar.transaction_date), 'DD-MM-YYYY') BETWEEN d.start_date AND d.end_date
        ${subClause}
        AND REPLACE(REPLACE(TRIM(ar.amount_remaining_foreign), '(', '-'), ')', '')::NUMERIC <> 0
    ),
 
    final AS (
      SELECT
        *,
        CASE
          WHEN age <= 0 THEN 'Current'
          WHEN age <= 30 THEN '1-30'
          WHEN age <= 60 THEN '31-60'
          WHEN age <= 90 THEN '61-90'
          ELSE '90+'
        END AS aging_bucket
      FROM base
    )
 
    SELECT
      customer_name,
      record_type,
      document_number,
      invoice_date,
      due_date,
      period,
      currency,
      status,
      open_balance,
      age,
      aging_bucket
    FROM final
    ORDER BY customer_name, invoice_date
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
