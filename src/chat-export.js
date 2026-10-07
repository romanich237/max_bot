const { getDatabase } = require('./config');

function esc(v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
async function rowsForChat(chatUrl) {
  const db = require('./db');
  if (!db.isEnabled()) {
    throw new Error('База данных отключена в config.json');
  }
  try {
    await db.initSchema();
    return await db.getMessagesForChat(chatUrl, 20000);
  } catch (err) {
    throw new Error(`Не удалось прочитать историю чата из ${getDatabase().driver.toUpperCase()}: ${err.message}`);
  }
}

function mediaHtml(raw) {
  let media=[]; try { media=typeof raw==='string'?JSON.parse(raw||'[]'):(raw||[]); } catch {}
  if(!Array.isArray(media)) return '';
  return media.map(m=>{
    const type=String(m.type||'файл'), src=String(m.url||m.sourceUrl||'');
    if (/photo|image/i.test(type) && /^https?:/i.test(src)) return `<img src="${esc(src)}" loading="lazy">`;
    if (/video/i.test(type) && /^https?:/i.test(src)) return `<video controls src="${esc(src)}"></video>`;
    if (/voice|audio/i.test(type) && /^https?:/i.test(src)) return `<audio controls src="${esc(src)}"></audio>`;
    return `<div class="media">📎 ${esc(type)}${src ? ` · <a href="${esc(src)}">медиа</a>` : ''}</div>`;
  }).join('');
}
function formatDateDivider(value) {
  const raw=String(value||'').trim();
  if(!raw) return '';

  const lower=raw.toLowerCase();
  if(lower==='сегодня') return 'Сегодня';
  if(lower==='вчера') return 'Вчера';

  const months=[
    'января','февраля','марта','апреля','мая','июня',
    'июля','августа','сентября','октября','ноября','декабря'
  ];

  let year,month,day;
  let m=raw.match(/^(\\d{4})[.\\/-](\\d{1,2})[.\\/-](\\d{1,2})(?:\\s.*)?$/);
  if(m) {
    year=Number(m[1]); month=Number(m[2]); day=Number(m[3]);
  } else {
    m=raw.match(/^(\\d{1,2})[.\\/-](\\d{1,2})[.\\/-](\\d{4})(?:\\s.*)?$/);
    if(m) { day=Number(m[1]); month=Number(m[2]); year=Number(m[3]); }
  }

  if(!year || month<1 || month>12 || day<1 || day>31) return raw;

  const target=new Date(year,month-1,day);
  const now=new Date();
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const yesterday=new Date(today);
  yesterday.setDate(today.getDate()-1);

  if(target.getTime()===today.getTime()) return 'Сегодня';
  if(target.getTime()===yesterday.getTime()) return 'Вчера';
  return `${day} ${months[month-1]} ${year}`;
}

async function buildChatExport(chatUrl,title) {
  const rows=await rowsForChat(chatUrl);
  const storedTitle=rows.map(row=>String(row.chat_title||'').trim()).find(Boolean);
  const fallbackTitle=/^Чат\s+-?\d+$/i.test(String(title||'').trim()) || !String(title||'').trim();
  const displayTitle=fallbackTitle && storedTitle ? storedTitle : String(title||storedTitle||'MAX').trim();
  let lastDate='';
  const messages=rows.map(row=>{
    const date=String(row.date_str||'').trim();
    const displayDate=formatDateDivider(date);
    const separator=date && date!==lastDate ? `<div class="date"><span>${esc(displayDate)}</span></div>` : '';
    if(date) lastDate=date;
    const author=esc(row.author||'MAX');
    const reply=row.reply_body
      ? `<div class="reply"><strong>${esc(row.reply_author||'Ответ')}</strong><div>${esc(row.reply_body).replace(/\n/g,'<br>')}</div></div>`
      : '';
    const body=String(row.body||'').trim()
      ? `<div class="body">${esc(row.body||'').replace(/\n/g,'<br>')}</div>`
      : '';
    const time=esc(row.clock_str||row.time_str||'');
    return `${separator}<div class="row ${row.is_own?'own':'incoming'}"><div class="bubble"><div class="author">${author}</div>${reply}${mediaHtml(row.media_json)}${body}<div class="meta"><span>${time}</span>${row.is_own?'<span class="checks">✓✓</span>':''}</div></div></div>`;
  }).join('');

  const html=`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(displayTitle)}</title>
<style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#111}
body{background:#8ec8ed}
body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.16;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180' viewBox='0 0 180 180'%3E%3Cg fill='none' stroke='%230b78ba' stroke-width='2'%3E%3Cpath d='M25 22l9 7-9 7-9-7zM123 21c14 4 19 15 9 24-12 10-26-2-18-13 5-7 13-4 14 2M48 105c17-10 34 8 22 22-13 15-36 3-29-14 4-9 15-12 23-7M119 108l17 17m0-17l-17 17M19 151c11-8 23 5 14 14-10 10-25-3-14-14zM151 66l6 9 10 2-7 7 1 10-10-5-9 5 2-10-8-7 10-2z'/%3E%3C/g%3E%3C/svg%3E")}
.header{position:sticky;top:0;z-index:5;height:64px;background:#fff;display:flex;align-items:center;padding:0 18px;box-shadow:0 1px 2px #0002}
.avatar{width:42px;height:42px;border-radius:50%;background:#eaf3fa;color:#1787d4;display:grid;place-items:center;font-weight:800;font-size:20px;margin-right:12px}
.title{font-size:17px;font-weight:700;line-height:1.15}.subtitle{font-size:13px;color:#7b7f83;margin-top:3px}
.chat{position:relative;z-index:1;max-width:760px;margin:auto;padding:18px 12px 50px;min-height:calc(100vh - 64px)}
.date{text-align:center;margin:10px 0 14px}.date span{display:inline-block;background:#4da7d6cc;color:#fff;border-radius:15px;padding:5px 12px;font-size:14px;font-weight:600;box-shadow:0 1px 1px #0001}
.row{display:flex;margin:5px 0}.row.own{justify-content:flex-end}.bubble{position:relative;max-width:min(78%,600px);background:#fff;border-radius:13px;padding:8px 10px 6px;box-shadow:0 1px 1px #0002;min-width:105px}
.incoming .bubble{border-bottom-left-radius:4px}.own .bubble{background:#e2ffc7;border-bottom-right-radius:4px}
.author{color:#168acd;font-weight:700;font-size:14px;margin-bottom:3px}.own .author{color:#4b9a38}
.reply{border-left:3px solid #27a4df;background:#00000008;border-radius:4px;padding:5px 8px;margin:2px 0 6px;font-size:13px;line-height:1.25}.reply strong{display:block;color:#168acd;margin-bottom:2px}
.body{font-size:16px;line-height:1.3;overflow-wrap:anywhere;margin:2px 0}
.meta{display:flex;justify-content:flex-end;align-items:center;gap:3px;color:#7e8589;font-size:11px;line-height:14px;margin:-1px 0 0 14px;min-height:14px}.own .meta{color:#679268}.checks{color:#3e9ed6;font-weight:700}
img,video{display:block;width:auto;max-width:100%;max-height:620px;border-radius:9px;margin:2px 0 6px;object-fit:contain}audio{display:block;width:min(360px,100%);margin:6px 0}.media{font-size:14px;background:#00000008;border-radius:8px;padding:8px;margin:5px 0}.media a{color:#168acd;text-decoration:none}
.empty{display:block;margin:30px auto;width:max-content;max-width:90%;background:#4da7d6cc;color:#fff;border-radius:15px;padding:7px 13px;font-size:14px}
@media(max-width:600px){.header{height:58px;padding:0 12px}.avatar{width:38px;height:38px}.chat{padding:12px 7px 32px;min-height:calc(100vh - 58px)}.bubble{max-width:88%;padding:7px 9px 5px}.body{font-size:16px}.title{font-size:16px}}
</style></head>
<body><header class="header"><div class="avatar">${esc(String(displayTitle||'M').trim().charAt(0).toUpperCase()||'M')}</div><div><div class="title">${esc(displayTitle)}</div><div class="subtitle">${rows.length} сообщений</div></div></header>
<main class="chat">${messages||'<div class="empty">В локальной истории сообщений пока нет</div>'}</main></body></html>`;
  return {html,count:rows.length,title:displayTitle};
}
module.exports={buildChatExport};
