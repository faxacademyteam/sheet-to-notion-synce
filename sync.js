const NOTION_VERSION = '2026-03-11';
const API_URL = process.env.API_URL;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

if (!API_URL || !NOTION_TOKEN || !DATABASE_ID) {
  throw new Error('Missing API_URL, NOTION_TOKEN, or NOTION_DATABASE_ID GitHub Secret.');
}

const notionHeaders = {
  Authorization: `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
};

async function notion(path, options = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: { ...notionHeaders, ...(options.headers || {}) },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.message || data?.code || text || `HTTP ${res.status}`;
    throw new Error(`Notion API ${res.status}: ${msg}`);
  }
  return data;
}

function norm(s) {
  return String(s ?? '').trim().toLowerCase();
}

function findProperty(schema, wanted) {
  const w = norm(wanted);
  return Object.entries(schema).find(([name]) => norm(name) === w)?.[0];
}

function cleanText(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[%,$\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (m) {
    const month = m[1].padStart(2, '0');
    const day = m[2].padStart(2, '0');
    return `${m[3]}-${month}-${day}`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function getPlainPropertyValue(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title': return prop.title?.map(x => x.plain_text || x.text?.content || '').join('') || '';
    case 'rich_text': return prop.rich_text?.map(x => x.plain_text || x.text?.content || '').join('') || '';
    case 'number': return prop.number;
    case 'select': return prop.select?.name || '';
    case 'status': return prop.status?.name || '';
    case 'date': return prop.date?.start || '';
    case 'url': return prop.url || '';
    case 'checkbox': return prop.checkbox;
    case 'email': return prop.email || '';
    case 'phone_number': return prop.phone_number || '';
    default: return '';
  }
}

function externalFile(url, name = 'Screenshot') {
  if (!url) return null;
  return { type: 'external', name, external: { url } };
}

function makeProperty(schemaProp, value, fieldName) {
  if (!schemaProp || value === null || value === undefined || value === '') return null;
  const type = schemaProp.type;
  const text = cleanText(value);

  switch (type) {
    case 'title':
      return { title: [{ type: 'text', text: { content: text.slice(0, 2000) } }] };
    case 'rich_text':
      return { rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }] };
    case 'number': {
      const n = toNumber(value);
      return n === null ? null : { number: n };
    }
    case 'date': {
      const d = parseDate(value);
      return d ? { date: { start: d } } : null;
    }
    case 'url':
      return { url: text };
    case 'email':
      return { email: text };
    case 'phone_number':
      return { phone_number: text };
    case 'checkbox':
      return { checkbox: value === true || norm(value) === 'true' || norm(value) === 'yes' };
    case 'select': {
      const options = schemaProp.select?.options || [];
      const match = options.find(o => norm(o.name) === norm(text));
      if (!match) {
        console.warn(`Skipping ${fieldName}: select option "${text}" does not exist in Notion.`);
        return null;
      }
      return { select: { name: match.name } };
    }
    case 'status': {
      const options = schemaProp.status?.options || [];
      const match = options.find(o => norm(o.name) === norm(text));
      if (!match) {
        console.warn(`Skipping ${fieldName}: status option "${text}" does not exist in Notion.`);
        return null;
      }
      return { status: { name: match.name } };
    }
    case 'files': {
      const f = externalFile(text, fieldName);
      return f ? { files: [f] } : null;
    }
    case 'formula':
    case 'rollup':
    case 'relation':
    case 'created_time':
    case 'created_by':
    case 'last_edited_time':
    case 'last_edited_by':
      // Read-only / calculated properties cannot be written.
      return null;
    default:
      console.warn(`Unsupported Notion property type ${type} for ${fieldName}; skipping.`);
      return null;
  }
}

async function fetchSourceRows() {
  const res = await fetch(API_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Google Apps Script API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const rows = Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : null);
  if (!rows) throw new Error('Google API did not return a JSON array.');
  return rows.filter(r => r && cleanText(r['TRADE NO']));
}

async function getDatabaseAndSchema() {
  const db = await notion(`/databases/${DATABASE_ID}`);
  const dataSources = db.data_sources || db.dataSources || [];
  if (!dataSources.length) {
    throw new Error('No data source found inside this Notion database.');
  }
  const ds = dataSources[0];
  const dataSource = await notion(`/data_sources/${ds.id}`);
  return { db, dataSource, dataSourceId: ds.id };
}

async function queryAllPages(dataSourceId) {
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const result = await notion(`/data_sources/${dataSourceId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    pages.push(...(result.results || []));
    cursor = result.has_more ? result.next_cursor : null;
  } while (cursor);
  return pages;
}

async function upsertPage(dataSourceId, pageId, properties) {
  if (pageId) {
    await notion(`/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    });
    return 'updated';
  }
  await notion('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
      properties,
    }),
  });
  return 'created';
}

async function main() {
  console.log('1) Reading Google Apps Script API...');
  const sourceRows = await fetchSourceRows();
  console.log(`   ${sourceRows.length} source rows found.`);

  console.log('2) Reading Notion database schema...');
  const { dataSource, dataSourceId } = await getDatabaseAndSchema();
  const schema = dataSource.properties || {};
  const tradeNoPropName = findProperty(schema, 'TRADE NO');
  if (!tradeNoPropName) {
    throw new Error(`Notion property "TRADE NO" was not found. Found: ${Object.keys(schema).join(', ')}`);
  }
  console.log(`   Data source: ${dataSourceId}`);
  console.log(`   TRADE NO property: ${tradeNoPropName} (${schema[tradeNoPropName].type})`);

  console.log('3) Reading existing Notion rows...');
  const pages = await queryAllPages(dataSourceId);
  const existing = new Map();
  for (const page of pages) {
    const value = getPlainPropertyValue(page.properties?.[tradeNoPropName]);
    if (value !== '' && value !== null && value !== undefined) {
      existing.set(String(value).trim(), page.id);
    }
  }
  console.log(`   ${pages.length} existing Notion rows found.`);

  const fieldNames = [
    'TRADE NO', 'MONTH', 'DATE', 'DAY', 'TIME', 'BUY/SELL', 'ENTRY', 'EXIT',
    'TIME HELD', 'RESULT', 'Screenshot', 'PIPS CAPTURED', 'PNL(PIPS)', 'ACCURACY'
  ];

  let created = 0, updated = 0, skipped = 0;

  for (const row of sourceRows) {
    const tradeNo = cleanText(row['TRADE NO']);
    const properties = {};

    for (const field of fieldNames) {
      const notionName = findProperty(schema, field);
      if (!notionName) continue;

      let value = row[field];
      if (field === 'Screenshot') {
        value = row.ScreenshotUrl || row[field];
      }
      const prop = makeProperty(schema[notionName], value, notionName);
      if (prop) properties[notionName] = prop;
    }

    // Ensure the unique key is always present.
    if (!properties[tradeNoPropName]) {
      properties[tradeNoPropName] = makeProperty(schema[tradeNoPropName], tradeNo, tradeNoPropName);
    }

    const action = await upsertPage(dataSourceId, existing.get(tradeNo), properties);
    if (action === 'created') created++;
    else updated++;
    console.log(`   ${action.toUpperCase()}: Trade ${tradeNo}`);
  }

  console.log(`DONE — created: ${created}, updated: ${updated}, skipped: ${skipped}`);
}

main().catch(err => {
  console.error('SYNC FAILED');
  console.error(err.stack || err.message || err);
  process.exit(1);
});
