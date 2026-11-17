/* ===== Shared logic: used by the PWA (browser) AND the Google Apps Script backend ===== */

var CATEGORIES = ['Food & Drink', 'Groceries', 'Transport', 'Bills & Utilities', 'Shopping',
  'Entertainment', 'Health', 'Travel', 'Transfers', 'Other'];

// Order matters: first match wins. Edit freely to suit where you spend.
var CATEGORY_RULES = [
  ['Food & Drink', /careem food|noon food|talabat|deliveroo|zomato|caribou|coffee|cafe|café|starbucks|costa|tim hortons|restaurant|kfc|mcdonald|burger|pizza|shawarma|bakery|kitchen|grill/i],
  ['Groceries', /carrefour|lulu|spinneys|waitrose|union coop|choithram|grocery|supermarket|hypermarket|kibsons|instashop|al maya|viva|nesto|west zone/i],
  ['Transport', /careem|uber|\brta\b|\bnol\b|salik|enoc|adnoc|eppco|emarat|petrol|fuel|parking|taxi|metro|hala/i],
  ['Bills & Utilities', /dewa|sewa|addc|fewa|etisalat|\be&|\bdu\b|virgin mobile|internet|empower|cooling|insurance/i],
  ['Entertainment', /netflix|spotify|osn|shahid|\bvox\b|reel cinema|novo|apple\.com|itunes|playstation|steam|youtube|anghami/i],
  ['Health', /pharmacy|aster|boots|clinic|hospital|medcare|dental|\bgym\b|fitness/i],
  ['Travel', /flydubai|etihad|air arabia|emirates airline|emirates\.com|booking\.com|agoda|airbnb|hotel|expedia/i],
  ['Shopping', /amazon|\bnoon\b|namshi|ikea|centrepoint|max fashion|h&m|zara|sharaf dg|jumbo|\bmall\b|ace hardware|shein|daiso/i]
];

function guessCategory(merchant, text) {
  var s = (merchant || '') + ' ' + (text || '');
  for (var i = 0; i < CATEGORY_RULES.length; i++) if (CATEGORY_RULES[i][1].test(merchant || '')) return CATEGORY_RULES[i][0];
  if (/transfer|remittance|sent to|beneficiary/i.test(s)) return 'Transfers';
  for (var j = 0; j < CATEGORY_RULES.length; j++) if (CATEGORY_RULES[j][1].test(s)) return CATEGORY_RULES[j][0];
  return 'Other';
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function isoDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function monthKey(dateStr) { return String(dateStr).slice(0, 7); }

var MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

function parseSmsDate(t, now) {
  var d = null, m;
  if ((m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/))) {          // 17/11/2026 (day first, UAE style)
    var y = +m[3]; if (y < 100) y += 2000;
    d = new Date(y, +m[2] - 1, +m[1]);
  } else if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) {                      // 2026-11-17
    d = new Date(+m[1], +m[2] - 1, +m[3]);
  } else if ((m = t.match(/\b(\d{1,2})[\s\-]?([A-Za-z]{3})[a-z]*[\s\-,]*(\d{2,4})\b/))) { // 17-Nov-26 / 17 Nov 2026
    var mi = MONTHS.indexOf(m[2].toLowerCase());
    if (mi >= 0) { var yy = +m[3]; if (yy < 100) yy += 2000; d = new Date(yy, mi, +m[1]); }
  }
  if (!d || isNaN(d)) return isoDate(now);
  var diffDays = (now - d) / 86400000;
  return (diffDays < -1 || diffDays > 60) ? isoDate(now) : isoDate(d); // ignore implausible dates
}

/**
 * Parse a bank SMS into a transaction.
 * Returns {ok:true, amount, currency, type, merchant, category, date} or {ok:false, reason}.
 */
function parseSms(text, now) {
  now = now || new Date();
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { ok: false, reason: 'Empty message' };
  if (/\b(otp|one[- ]time (password|pin|code)|verification code|passcode|activation code)\b/i.test(t)) return { ok: false, reason: 'OTP / security message' };
  if (/\b(declined|unsuccessful|failed|was not approved|insufficient)\b/i.test(t)) return { ok: false, reason: 'Declined transaction' };
  if (/\b(offer|promo|apply now|t&cs? apply|win |get up to|limited time)\b/i.test(t)) return { ok: false, reason: 'Promotional message' };

  var CUR = '(AED|USD|EUR|GBP|SAR|INR|QAR|OMR|KWD|BHD|Dhs?)';
  var NUM = '([0-9][0-9,]*(?:\\.[0-9]{1,2})?)';
  var re = new RegExp(CUR + '\\s?\\.?\\s?' + NUM + '|' + NUM + '\\s?' + CUR, 'gi');
  var m, found = null;
  while ((m = re.exec(t))) {
    var before = t.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
    if (/(avl|avail|available|bal|balance|limit|outstanding|due|minimum|min)\.?\s*(cr\.?\s*limit\s*)?(is|:|of|amt|amount)?\s*$/.test(before)) continue;
    found = m; break;
  }
  if (!found) return { ok: false, reason: 'No amount found' };

  var currency = (found[1] || found[4]).toUpperCase();
  if (/^DHS?$/.test(currency)) currency = 'AED';
  var amount = parseFloat((found[2] || found[3]).replace(/,/g, ''));
  if (!(amount > 0)) return { ok: false, reason: 'No amount found' };

  var debitRe = /\b(spent|purchase|purchased|debited|used|paid|payment|withdrawn|withdrawal|charged|deducted|txn|transaction|sent)\b/i;
  var creditRe = /\b(credited|received|refund|refunded|reversal|deposited|deposit|cashback|salary)\b/i;
  var isDebit = debitRe.test(t), isCredit = creditRe.test(t);
  if (!isDebit && !isCredit) return { ok: false, reason: 'Not a transaction message' };
  // If both appear, whichever word comes first decides.
  var type = 'expense';
  if (isCredit && (!isDebit || t.search(creditRe) < t.search(debitRe))) type = 'income';

  var merchant = '';
  var stop = '(?=\\s+on\\s|\\s+(?:received|has|was|is|for)\\b|\\s+dated|[,;]|\\.\\s|\\.$|\\s+avl|\\s+avail|\\s+available|\\s+bal|\\s+ref|\\s+using|\\s+with|\\s+via|$)';
  var patterns = type === 'income'
    ? [new RegExp('\\bfrom\\s+([A-Za-z*][^]*?)' + stop, 'i')]
    : [new RegExp('\\b(?:at|@)\\s+([A-Za-z*][^]*?)' + stop, 'gi'), new RegExp('\\b(?:to|towards)\\s+([A-Za-z*][^]*?)' + stop, 'i')];
  for (var p = 0; p < patterns.length && !merchant; p++) {
    var mm = patterns[p].exec(t);
    if (mm) merchant = mm[1];
  }
  merchant = merchant.replace(/\s*-\s*(ARE|UAE|AE)$/i, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (/^(your|the|a\/c|account|card)\b/i.test(merchant)) merchant = '';

  return {
    ok: true, amount: Math.round(amount * 100) / 100, currency: currency, type: type,
    merchant: merchant || (type === 'income' ? 'Incoming' : 'Card payment'),
    category: type === 'income' ? 'Income' : guessCategory(merchant, t),
    date: parseSmsDate(t, now)
  };
}

/** Totals for one month (YYYY-MM). */
function summarize(txs, budgets, month) {
  var byCat = {}, spent = 0, income = 0;
  txs.forEach(function (x) {
    if (monthKey(x.date) !== month) return;
    var a = Number(x.amount) || 0;
    if (x.type === 'income') { income += a; return; }
    spent += a;
    byCat[x.category] = (byCat[x.category] || 0) + a;
  });
  return { month: month, spent: spent, income: income, byCat: byCat, overall: Number(budgets.Overall) || 0 };
}

function fmtMoney(n, cur) { return (cur || 'AED') + ' ' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }

/** Short status text after adding a transaction (shown as the iPhone notification / in-app toast). */
function alertMessage(tx, txs, budgets, currency) {
  var s = summarize(txs, budgets, monthKey(tx.date));
  var cur = currency || tx.currency || 'AED';
  var parts = [];
  var head = (tx.type === 'income' ? '+' : '') + fmtMoney(tx.amount, cur) + (tx.merchant ? ' · ' + tx.merchant : '') + (tx.type === 'income' ? '' : ' (' + tx.category + ')');
  parts.push(head);
  var warn = '';
  if (tx.type !== 'income') {
    var cl = Number(budgets[tx.category]) || 0;
    if (cl) {
      var cs = s.byCat[tx.category] || 0, cp = Math.round(cs / cl * 100);
      parts.push(tx.category + ': ' + fmtMoney(cs, cur) + ' / ' + fmtMoney(cl, cur) + ' (' + cp + '%)');
      if (cp >= 100) warn = '⛔ ' + tx.category + ' budget exceeded!';
      else if (cp >= 80) warn = '⚠️ ' + tx.category + ' at ' + cp + '% of budget';
    }
    if (s.overall) {
      var op = Math.round(s.spent / s.overall * 100);
      parts.push('Month: ' + fmtMoney(s.spent, cur) + ' / ' + fmtMoney(s.overall, cur) + ' (' + op + '%)');
      if (op >= 100) warn = '⛔ Monthly budget exceeded!';
      else if (op >= 80 && !warn) warn = '⚠️ Monthly spend at ' + op + '%';
    }
  }
  if (warn) parts.unshift(warn);
  return parts.join('\n');
}

function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

if (typeof module !== 'undefined') module.exports = { CATEGORIES: CATEGORIES, parseSms: parseSms, guessCategory: guessCategory, summarize: summarize, alertMessage: alertMessage, isoDate: isoDate };
