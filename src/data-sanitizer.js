'use strict';
/**
 * crm-data-hygiene-sentinel / data-sanitizer.js
 *
 * Zero-dependency helpers for cleaning CRM records:
 *   - phone normalization to E.164
 *   - personal vs corporate domain detection / corporate domain extraction
 *   - company and person name cleaning
 *   - completeness scoring, flagging and duplicate detection
 *   - CRM payload builders (HubSpot / Salesforce)
 *
 * Usage (library):
 *   const { sanitizeRecord, findDuplicates } = require('./src/data-sanitizer');
 *   const result = sanitizeRecord({ first_name: 'jane', phone: '(415) 555-0132' });
 *
 * Usage (CLI):
 *   node src/data-sanitizer.js tests/sample-payload.json
 *
 * NOTE: The n8n workflow embeds a copy of this logic in its
 * "Sanitize & Score" Code node. Keep both in sync when you change either.
 *
 * Phone parsing is heuristic. For strict per-country validation, use
 * libphonenumber-js instead of normalizePhone().
 */

const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'ymail.com', 'rocketmail.com',
  'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.net', 'gmx.de', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'mail.ru',
  'qq.com', '163.com', '126.com', 'fastmail.com', 'hey.com', 'tutanota.com', 'tuta.io',
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'btinternet.com', 'rediffmail.com',
  'web.de', 'orange.fr', 'free.fr', 'libero.it',
]);
const PERSONAL_PREFIXES = ['gmail.', 'yahoo.', 'hotmail.', 'outlook.'];
const NON_CORPORATE_SITES = new Set([
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com', 'youtube.com', 'linktr.ee',
]);
const DIAL_CODES = {
  US: '1', CA: '1', GB: '44', IE: '353', DE: '49', FR: '33', ES: '34', IT: '39', NL: '31', BE: '32',
  CH: '41', SE: '46', NO: '47', DK: '45', PL: '48', AU: '61', NZ: '64', SG: '65', IN: '91', BD: '880',
  PK: '92', AE: '971', SA: '966', ZA: '27', NG: '234', BR: '55', MX: '52', AR: '54', JP: '81',
  KR: '82', CN: '86', PH: '63', ID: '62',
};
const LEGAL_SUFFIXES = new Map([
  ['llc', 'LLC'], ['llp', 'LLP'], ['lp', 'LP'], ['pllc', 'PLLC'],
  ['inc', 'Inc.'], ['incorporated', 'Inc.'], ['corp', 'Corp.'], ['corporation', 'Corp.'],
  ['ltd', 'Ltd.'], ['limited', 'Ltd.'], ['plc', 'PLC'], ['gmbh', 'GmbH'], ['pty', 'Pty'], ['co', 'Co.'],
]);
const KEEP_UPPER = new Set([
  'llc', 'llp', 'lp', 'pllc', 'plc', 'usa', 'uk', 'ai', 'hr', 'seo', 'crm', 'saas', 'b2b', 'b2c', 'erp', 'api',
  'ibm', 'hp', 'bmw',
]);
const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to',
  'de', 'la', 'von', 'van', 'du', 'da',
]);
const JUNK = new Set(['n/a', 'na', 'none', 'null', 'undefined', 'unknown', 'tbd', '-', '.']);
const EMAIL_RE = /^[^@ ]+@[^@ ]+[.][^@ ]{2,}$/;
const DOMAIN_RE = /^[a-z0-9-]+([.][a-z0-9-]+)+$/;
const APOS = String.fromCharCode(39);
const BSLASH = String.fromCharCode(92);

const ALIASES = {
  firstname: ['firstname', 'givenname', 'fname'],
  lastname: ['lastname', 'surname', 'familyname', 'lname'],
  fullname: ['fullname', 'name', 'contactname'],
  email: ['email', 'emailaddress', 'workemail', 'mail'],
  phone: ['phone', 'phonenumber', 'mobilephone', 'mobile', 'telephone', 'tel', 'cell'],
  company: ['company', 'companyname', 'organization', 'organisation', 'employer', 'account'],
  website: ['website', 'companywebsite', 'url', 'domain', 'companydomain'],
  country: ['country', 'countrycode'],
};
const DEFAULT_REQUIRED = ['email', 'firstname', 'lastname', 'company', 'phone'];

function tidy(value) {
  if (value === null || value === undefined || typeof value === 'object') return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  return JUNK.has(s.toLowerCase()) ? '' : s;
}

function indexRecord(rec) {
  const idx = Object.create(null);
  for (const k of Object.keys(rec)) {
    idx[k.toLowerCase().split('_').join('').split(' ').join('').split('-').join('')] = rec[k];
  }
  return idx;
}

function pick(idx, names) {
  for (const n of names) {
    const v = tidy(idx[n]);
    if (v) return v;
  }
  return '';
}

function titleCase(word) {
  return word
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join('-')
    .replace(/^([a-z])'([a-z])/i, (m, a, b) => a.toUpperCase() + APOS + b.toUpperCase());
}

function isPersonalDomain(domain, extra) {
  const d = tidy(domain).toLowerCase();
  if (!d) return false;
  if (PERSONAL_DOMAINS.has(d) || (extra || []).indexOf(d) !== -1) return true;
  return d.split('.').length <= 3 && PERSONAL_PREFIXES.some((p) => d.startsWith(p));
}

function extractDomainFromUrl(raw) {
  let s = tidy(raw).toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z]+:[/][/]/, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  if (s.indexOf('@') !== -1) s = s.split('@').pop();
  s = s.split(':')[0];
  if (s.startsWith('www.')) s = s.slice(4);
  return DOMAIN_RE.test(s) ? s : '';
}

function normalizeEmail(raw) {
  const input = tidy(raw);
  let e = input.toLowerCase().replace(/^[<]+|[>]+$/g, '');
  if (e.startsWith('mailto:')) e = e.slice(7);
  const valid = e.length > 0 && e.length <= 254 && EMAIL_RE.test(e);
  return { input, email: valid ? e : '', valid, domain: valid ? e.split('@')[1] : '' };
}

function deriveCorporateDomain(emailDomain, website, extra) {
  const web = extractDomainFromUrl(website);
  if (web && !isPersonalDomain(web, extra) && !NON_CORPORATE_SITES.has(web)) {
    return { domain: web, source: 'website', website: web };
  }
  if (emailDomain && !isPersonalDomain(emailDomain, extra)) {
    return { domain: emailDomain, source: 'email', website: '' };
  }
  return { domain: '', source: 'none', website: '' };
}

function normalizePhone(raw, defaultCountry) {
  const out = { e164: '', valid: false, extension: '', reason: '' };
  let s = tidy(raw);
  if (!s) { out.reason = 'missing'; return out; }
  const m = s.match(/(?:extension|ext[.]?|x|#)[ ]*([0-9]{1,6})$/i);
  if (m) { out.extension = m[1]; s = s.slice(0, m.index); }
  const hasPlus = s.trim().startsWith('+');
  const digits = s.replace(/[^0-9]/g, '');
  if (!digits) { out.reason = 'no_digits'; return out; }
  const cc = DIAL_CODES[String(defaultCountry || 'US').toUpperCase()] || '1';
  let full = digits;
  if (!hasPlus) {
    if (digits.startsWith('00')) {
      full = digits.slice(2);
    } else if (cc === '1') {
      if (digits.length === 10) full = '1' + digits;
      else if (digits.length === 11 && digits[0] === '1') full = digits;
      else { out.reason = 'invalid_length'; return out; }
    } else if (!(digits.startsWith(cc) && digits.length >= cc.length + 9)) {
      full = cc + digits.replace(/^0+/, '');
    }
  }
  if (full[0] === '1') {
    if (!/^1[2-9][0-9]{2}[2-9][0-9]{6}$/.test(full)) { out.reason = 'invalid_nanp'; return out; }
  } else if (full.length < 8 || full.length > 15) {
    out.reason = 'invalid_length';
    return out;
  }
  out.e164 = '+' + full;
  out.valid = true;
  return out;
}

function cleanPersonName(raw) {
  const s = tidy(raw);
  if (!s) return '';
  return s
    .split(' ')
    .map((w) => {
      const hasLower = w !== w.toUpperCase();
      const hasUpper = w !== w.toLowerCase();
      if (!hasLower && !hasUpper) return w;
      if (hasLower && hasUpper && w !== titleCase(w)) return w;
      return titleCase(w);
    })
    .join(' ');
}

function caseCompanyWord(word, index) {
  const core = word.replace(/[.]+$/, '');
  const trail = word.slice(core.length);
  const lower = core.toLowerCase();
  if (index > 0 && LEGAL_SUFFIXES.has(lower)) return LEGAL_SUFFIXES.get(lower);
  if (KEEP_UPPER.has(lower)) return core.toUpperCase() + trail;
  if (index > 0 && SMALL_WORDS.has(lower)) return lower + trail;
  const hasLower = core !== core.toUpperCase();
  const hasUpper = core !== core.toLowerCase();
  if (!hasLower && !hasUpper) return word;
  if (hasUpper && !hasLower) return (core.length <= 3 ? core : titleCase(core)) + trail;
  if (hasLower && hasUpper && core !== titleCase(core)) return word;
  return titleCase(core) + trail;
}

function cleanCompanyName(raw) {
  let s = tidy(raw).split(',').join('');
  s = s.replace(/^[-;:|' ]+|[-;:|' ]+$/g, '');
  if (!s) return '';
  return s
    .split(' ')
    .filter(Boolean)
    .map((w, i) => caseCompanyWord(w, i))
    .join(' ');
}

function sanitizeRecord(input, options) {
  const opts = Object.assign(
    { defaultCountry: 'US', requiredFields: DEFAULT_REQUIRED, extraPersonalDomains: [] },
    options || {}
  );
  const idx = indexRecord(input && typeof input === 'object' ? input : {});
  const get = (names) => pick(idx, names);
  let first = get(ALIASES.firstname);
  let last = get(ALIASES.lastname);
  const full = get(ALIASES.fullname);
  if (!first && !last && full) {
    const parts = full.split(' ');
    first = parts.shift();
    last = parts.join(' ');
  }
  const countryRaw = get(ALIASES.country).toUpperCase();
  const country = Object.prototype.hasOwnProperty.call(DIAL_CODES, countryRaw)
    ? countryRaw
    : String(opts.defaultCountry).toUpperCase();
  const emailInfo = normalizeEmail(get(ALIASES.email));
  const phoneRaw = get(ALIASES.phone);
  const phoneInfo = normalizePhone(phoneRaw, country);
  const companyRaw = get(ALIASES.company);
  const corp = deriveCorporateDomain(emailInfo.domain, get(ALIASES.website), opts.extraPersonalDomains);
  const personalEmail = emailInfo.valid && isPersonalDomain(emailInfo.domain, opts.extraPersonalDomains);
  const clean = {
    firstname: cleanPersonName(first),
    lastname: cleanPersonName(last),
    email: emailInfo.email,
    phone: phoneInfo.e164,
    phone_extension: phoneInfo.extension,
    company: cleanCompanyName(companyRaw),
    website: corp.website,
    company_domain: corp.domain,
    domain_source: corp.source,
  };
  const required = (opts.requiredFields || DEFAULT_REQUIRED).map((f) => String(f).toLowerCase());
  const missing = required.filter((f) => !clean[f]);
  const flags = missing.map((f) => 'MISSING_' + f.toUpperCase());
  if (!emailInfo.input && missing.indexOf('email') === -1) flags.push('MISSING_EMAIL');
  if (emailInfo.input && !emailInfo.valid) flags.push('INVALID_EMAIL');
  if (phoneRaw && !phoneInfo.valid) flags.push('INVALID_PHONE');
  if (personalEmail) flags.push('PERSONAL_EMAIL');
  if (!clean.company_domain) flags.push('NO_CORPORATE_DOMAIN');
  const status = !clean.email ? 'unidentifiable' : missing.length ? 'incomplete' : 'complete';
  const completeness = required.length
    ? Math.round(((required.length - missing.length) / required.length) * 100)
    : 100;
  const changes = [];
  const track = (field, before, after) => {
    if (before && before !== after) changes.push({ field, from: before, to: after });
  };
  track('firstname', first, clean.firstname);
  track('lastname', last, clean.lastname);
  track('email', emailInfo.input, clean.email);
  track('phone', phoneRaw, clean.phone);
  track('company', companyRaw, clean.company);
  const dedupeKeys = { hard: [], soft: [] };
  if (clean.email) dedupeKeys.hard.push('email:' + clean.email);
  if (clean.firstname && clean.lastname && (clean.company_domain || clean.company)) {
    dedupeKeys.soft.push(
      'person:' + [clean.firstname, clean.lastname, clean.company_domain || clean.company].join('|').toLowerCase()
    );
  }
  return { clean, flags, missing, completeness, status, personalEmail, dedupeKeys, changes };
}

function findDuplicates(results) {
  const hard = new Map();
  const soft = new Map();
  return results.map((r, index) => {
    let duplicateOf = null;
    let possibleDuplicateOf = null;
    for (const k of r.dedupeKeys.hard) { if (hard.has(k)) { duplicateOf = hard.get(k); break; } }
    for (const k of r.dedupeKeys.soft) { if (soft.has(k)) { possibleDuplicateOf = soft.get(k); break; } }
    const root = duplicateOf === null ? index : duplicateOf;
    r.dedupeKeys.hard.forEach((k) => { if (!hard.has(k)) hard.set(k, root); });
    r.dedupeKeys.soft.forEach((k) => { if (!soft.has(k)) soft.set(k, root); });
    return { index, duplicateOf, possibleDuplicateOf };
  });
}

function buildHubSpotProperties(clean, hygiene) {
  const p = {};
  const add = (k, v) => { if (v) p[k] = v; };
  add('firstname', clean.firstname);
  add('lastname', clean.lastname);
  add('email', clean.email);
  add('phone', clean.phone);
  add('company', clean.company);
  add('website', clean.website || clean.company_domain);
  if (hygiene) {
    p.sentinel_status = hygiene.status;
    p.sentinel_flags = hygiene.flags.join(';');
    p.sentinel_last_checked = hygiene.checkedOn;
  }
  return p;
}

function buildHubSpotEmailSearch(email) {
  if (!email) return null;
  return {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email'],
    limit: 1,
  };
}

function buildSalesforceFields(clean, hygiene, forCreate) {
  const f = {};
  const add = (k, v) => { if (v) f[k] = v; };
  add('FirstName', clean.firstname);
  add('LastName', clean.lastname);
  add('Email', clean.email);
  add('Phone', clean.phone);
  add('Company', clean.company);
  add('Website', clean.website || clean.company_domain);
  if (forCreate) {
    if (!f.LastName) f.LastName = '[Unknown]';
    if (!f.Company) f.Company = '[Not Provided]';
  }
  if (hygiene) {
    f.Sentinel_Status__c = hygiene.status;
    f.Sentinel_Flags__c = hygiene.flags.join(';');
    f.Sentinel_Last_Checked__c = hygiene.checkedOn;
  }
  return f;
}

function escapeSoql(value) {
  return String(value).split(BSLASH).join(BSLASH + BSLASH).split(APOS).join(BSLASH + APOS);
}

function buildEmailLookupSoql(email) {
  return 'SELECT Id FROM Lead WHERE Email = ' + APOS + escapeSoql(email) + APOS + ' AND IsConverted = false LIMIT 1';
}

module.exports = {
  PERSONAL_DOMAINS,
  tidy,
  isPersonalDomain,
  extractDomainFromUrl,
  normalizeEmail,
  deriveCorporateDomain,
  normalizePhone,
  cleanPersonName,
  cleanCompanyName,
  sanitizeRecord,
  findDuplicates,
  buildHubSpotProperties,
  buildHubSpotEmailSearch,
  buildSalesforceFields,
  escapeSoql,
  buildEmailLookupSoql,
};

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const file = process.argv[2] || path.join(__dirname, '..', 'tests', 'sample-payload.json');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const records = Array.isArray(payload) ? payload : payload.records || [payload];
  const results = records.map((r) =>
    sanitizeRecord(r, { defaultCountry: process.env.SENTINEL_DEFAULT_COUNTRY || 'US' })
  );
  const dups = findDuplicates(results);
  const report = results.map((r, i) =>
    Object.assign({ index: i }, r, {
      duplicateOf: dups[i].duplicateOf,
      possibleDuplicateOf: dups[i].possibleDuplicateOf,
    })
  );
  console.log(JSON.stringify(report, null, 2));
}
