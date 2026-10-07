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
  let media=[];
  try { media=typeof raw==='string'?JSON.parse(raw||'[]'):(raw||[]); } catch {}
  if(!Array.isArray(media)) return '';

  const validSrc=(value)=>/^(?:https?:|data:|blob:)/i.test(String(value||''));
  return media.map((m)=>{
    const type=String(m.type||'file').toLowerCase();
    const src=String(m.url||m.sourceUrl||m.src||'');
    const name=String(m.fileName||m.filename||m.name||'').trim();
    const duration=String(m.duration||'').trim();

    if(type==='sticker'){
      if(validSrc(src)) return `<div class="sticker-wrap"><img class="sticker" src="${esc(src)}" loading="lazy" alt="Стикер"></div>`;
      return '<div class="attachment sticker-file"><span class="file-icon">🙂</span><div><b>Стикер</b><small>изображение недоступно в сохранённой истории</small></div></div>';
    }
    if(/photo|image/.test(type) && validSrc(src))
      return `<a class="media-link" href="${esc(src)}" target="_blank"><img class="photo" src="${esc(src)}" loading="lazy" alt="Фото"></a>`;
    if(/gif|animation/.test(type) && validSrc(src))
      return `<video class="gif" autoplay loop muted playsinline controls src="${esc(src)}"></video>`;
    if(/video/.test(type) && validSrc(src))
      return `<video controls playsinline preload="metadata" src="${esc(src)}"></video>`;
    if(/voice|audio/.test(type) && validSrc(src))
      return `<div class="audio-box"><span class="audio-icon">▶</span><audio controls preload="metadata" src="${esc(src)}"></audio>${duration?`<small>${esc(duration)}</small>`:''}</div>`;

    if(type==='file'||name){
      const label=name||'Файл';
      const ext=(label.match(/\.([^.]+)$/)||[])[1]||'';
      return `<div class="attachment"><span class="file-icon">↓</span><div class="file-info"><b>${esc(label)}</b><small>${esc(ext?ext.toUpperCase():'Файл')}</small></div>${validSrc(src)?`<a class="download" href="${esc(src)}" target="_blank" download>Скачать</a>`:''}</div>`;
    }
    if(validSrc(src)) return `<div class="attachment"><span class="file-icon">↓</span><div class="file-info"><b>${esc(type||'Медиа')}</b></div><a class="download" href="${esc(src)}" target="_blank">Открыть</a></div>`;
    return `<div class="attachment"><span class="file-icon">📎</span><div class="file-info"><b>${esc(name||type||'Медиа')}</b></div></div>`;
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
  let m=raw.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})(?:\s.*)?$/);
  if(m) {
    year=Number(m[1]); month=Number(m[2]); day=Number(m[3]);
  } else {
    m=raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})(?:\s.*)?$/);
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

function normalizeStoredDate(value) {
  const raw=String(value||'').trim().toLowerCase();
  if(!raw) return '';
  const now=new Date();
  if(raw==='сегодня') return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  if(raw==='вчера') {
    const d=new Date(now.getFullYear(),now.getMonth(),now.getDate()-1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  let m=raw.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
  if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m=raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);
  if(m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return '';
}

function rowTimestamp(row,index) {
  const date=normalizeStoredDate(row.date_str);
  const clock=String(row.clock_str||row.time_str||'').match(/(\d{1,2}):(\d{2})/);
  if(date) {
    const time=clock ? `${clock[1].padStart(2,'0')}:${clock[2]}` : '00:00';
    const ts=Date.parse(`${date}T${time}:00`);
    if(Number.isFinite(ts)) return {ts,index};
  }
  const created=Date.parse(String(row.created_at||''));
  return {ts:Number.isFinite(created)?created:Number.MAX_SAFE_INTEGER,index};
}

function sortRowsChronologically(rows) {
  return rows
    .map((row,index)=>({row,...rowTimestamp(row,index)}))
    .sort((a,b)=>a.ts-b.ts || a.index-b.index)
    .map(item=>item.row);
}

async function buildChatExport(chatUrl,title) {
  const rows=sortRowsChronologically(await rowsForChat(chatUrl));
  const storedTitle=rows.map(row=>String(row.chat_title||'').trim()).find(Boolean);
  const fallbackTitle=/^Чат\s+-?\d+$/i.test(String(title||'').trim()) || !String(title||'').trim();
  const displayTitle=fallbackTitle && storedTitle ? storedTitle : String(title||storedTitle||'MAX').trim();
  let lastDate='';
  const messages=rows.map(row=>{
    const date=String(row.date_str||'').trim();
    const displayDate=formatDateDivider(date);
    const separator=date && date!==lastDate ? `<div class="date"><span>${esc(displayDate)}</span></div>` : '';
    if(date) lastDate=date;
    const rawAuthor=String(row.author||'').trim();
    const showAuthor=rawAuthor && !/^(неизвестно|unknown|max)$/i.test(rawAuthor);
    const author=showAuthor ? `<div class="author">${esc(rawAuthor)}</div>` : '';
    const reply=row.reply_body
      ? `<div class="reply"><strong>${esc(row.reply_author||'Ответ')}</strong><div>${esc(row.reply_body).replace(/\n/g,'<br>')}</div></div>`
      : '';
    const deleted=Boolean(Number(row.is_deleted||0));
    const body=deleted
      ? '<div class="body deleted-message">🚫 Сообщение удалено в MAX</div>'
      : String(row.body||'').trim()
        ? `<div class="body">${esc(row.body||'').replace(/\n/g,'<br>')}</div>`
        : '';
    const time=esc(row.clock_str||row.time_str||'');
    return `${separator}<div class="row ${row.is_own?'own':'incoming'}"><div class="bubble">${author}${reply}${deleted?'':mediaHtml(row.media_json)}${body}<div class="meta"><span>${time}</span>${row.is_own?'<span class="checks">✓✓</span>':''}</div></div></div>`;
  }).join('');

  const html=`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(displayTitle)}</title>
<style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#111}
body{background:#8ec8ed}
body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.16;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180' viewBox='0 0 180 180'%3E%3Cg fill='none' stroke='%230b78ba' stroke-width='2'%3E%3Cpath d='M25 22l9 7-9 7-9-7zM123 21c14 4 19 15 9 24-12 10-26-2-18-13 5-7 13-4 14 2M48 105c17-10 34 8 22 22-13 15-36 3-29-14 4-9 15-12 23-7M119 108l17 17m0-17l-17 17M19 151c11-8 23 5 14 14-10 10-25-3-14-14zM151 66l6 9 10 2-7 7 1 10-10-5-9 5 2-10-8-7 10-2z'/%3E%3C/g%3E%3C/svg%3E")}
.header{position:relative;z-index:5;height:64px;background:#fff;display:flex;align-items:center;padding:0 18px;box-shadow:0 1px 2px #0002}
.avatar{width:42px;height:42px;border-radius:50%;background:#eaf3fa;color:#1787d4;display:grid;place-items:center;font-weight:800;font-size:20px;margin-right:12px}
.title{font-size:17px;font-weight:700;line-height:1.15}.subtitle{font-size:13px;color:#7b7f83;margin-top:3px}
.chat{position:relative;z-index:1;max-width:860px;margin:auto;padding:12px 14px 40px;min-height:calc(100vh - 64px)}
.date{text-align:center;margin:7px 0 10px}.date span{display:inline-block;background:#4da7d6cc;color:#fff;border-radius:15px;padding:5px 12px;font-size:14px;font-weight:600;box-shadow:0 1px 1px #0001}
.row{display:flex;margin:3px 0}.row.own{justify-content:flex-end}.bubble{position:relative;max-width:min(82%,640px);background:#fff;border-radius:13px;padding:7px 10px 5px;box-shadow:0 1px 1px #0002;min-width:72px}
.incoming .bubble{border-bottom-left-radius:4px}.own .bubble{background:#e2ffc7;border-bottom-right-radius:4px}
.author{color:#168acd;font-weight:700;font-size:13px;margin-bottom:2px}.own .author{color:#4b9a38}
.reply{border-left:3px solid #27a4df;background:#00000008;border-radius:4px;padding:5px 8px;margin:2px 0 6px;font-size:13px;line-height:1.25}.reply strong{display:block;color:#168acd;margin-bottom:2px}
.body{font-size:15px;line-height:1.28;overflow-wrap:anywhere;margin:1px 0}.deleted-message{color:#7d858a;font-style:italic}
.meta{display:flex;justify-content:flex-end;align-items:center;gap:3px;color:#7e8589;font-size:10px;line-height:12px;margin:-1px 0 0 12px;min-height:12px}.own .meta{color:#679268}.checks{color:#3e9ed6;font-weight:700}
img,video{display:block;width:auto;max-width:100%;max-height:620px;border-radius:9px;margin:2px 0 6px;object-fit:contain}.media-link{display:block;text-decoration:none}.photo{max-width:100%}.gif{min-width:180px}.sticker-wrap{background:transparent;padding:2px 0}.sticker{width:auto;max-width:220px;max-height:220px;background:transparent;box-shadow:none}.audio-box{display:flex;align-items:center;gap:8px;min-width:280px;padding:5px 0}.audio-box audio{width:min(340px,100%);height:36px}.audio-box small{white-space:nowrap;color:#6d777d}.audio-icon{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:#168acd;color:#fff;font-size:12px}.attachment{display:flex;align-items:center;gap:10px;min-width:260px;max-width:440px;padding:7px 2px}.file-icon{flex:0 0 40px;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;background:#168acd;color:#fff;font-size:22px;font-weight:700}.file-info{min-width:0;flex:1}.file-info b,.attachment>div>b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}.file-info small,.attachment>div>small{display:block;color:#758087;margin-top:2px;font-size:12px}.download{color:#168acd;text-decoration:none;font-size:13px;font-weight:600;white-space:nowrap}.own .file-icon,.own .audio-icon{background:#5da24d}.own .download{color:#438d36}
.empty{display:block;margin:30px auto;width:max-content;max-width:90%;background:#4da7d6cc;color:#fff;border-radius:15px;padding:7px 13px;font-size:14px}
@media(max-width:600px){.header{height:54px;padding:0 10px}.avatar{width:36px;height:36px;margin-right:9px;font-size:17px}.title{font-size:15px}.subtitle{font-size:11px;margin-top:1px}.chat{padding:8px 6px 24px;min-height:calc(100vh - 54px)}.date{margin:5px 0 8px}.date span{font-size:12px;padding:4px 9px}.row{margin:2px 0}.bubble{max-width:91%;padding:6px 8px 4px;border-radius:11px}.body{font-size:14px;line-height:1.25}.author{font-size:12px}.meta{font-size:9px;line-height:11px;min-height:11px}.sticker{max-width:180px;max-height:180px}.attachment{min-width:220px}.audio-box{min-width:220px}}
</style></head>
<body><header class="header"><div class="avatar">${esc(String(displayTitle||'M').trim().charAt(0).toUpperCase()||'M')}</div><div><div class="title">${esc(displayTitle)}</div><div class="subtitle">${rows.length} сообщений</div></div></header>
<main class="chat">${messages||'<div class="empty">В локальной истории сообщений пока нет</div>'}</main></body></html>`;
  return {html,count:rows.length,title:displayTitle};
}
module.exports={buildChatExport};
