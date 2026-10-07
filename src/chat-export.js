const fs = require('fs');
const path = require('path');
const { getDatabase } = require('./config');

function esc(v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
async function rowsForChat(chatUrl) {
  const cfg=getDatabase();
  if (cfg.driver === 'mysql') {
    const mysql=require('mysql2/promise');
    const pool=mysql.createPool({host:cfg.host,port:cfg.port,user:cfg.user,password:cfg.password,database:cfg.database,charset:'utf8mb4'});
    try {
      const [rows]=await pool.query(`SELECT author,body,time_str,date_str,clock_str,is_own,media_json,reply_author,reply_body,created_at FROM messages WHERE chat_url=? ORDER BY id ASC LIMIT 20000`,[chatUrl]);
      return rows;
    } finally { await pool.end(); }
  }
  let filename=cfg.file;
  if (!filename || !fs.existsSync(filename)) {
    const roots=[
      path.dirname(cfg.file || ''),
      path.resolve(__dirname,'../data'),
      path.resolve(__dirname,'..'),
      process.cwd(),
    ].filter(Boolean);
    const candidates=[
      filename,
      ...roots.flatMap((root)=>['max.db','data.db','users.db','messages.db','database.db'].map((name)=>path.join(root,name))),
    ].filter(Boolean);
    filename=candidates.find((candidate)=>fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!filename) {
      for (const root of roots) {
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
        const found=fs.readdirSync(root,{withFileTypes:true})
          .filter((entry)=>entry.isFile() && /\.(?:db|sqlite|sqlite3)$/i.test(entry.name))
          .map((entry)=>path.join(root,entry.name))
          .find((candidate)=>fs.existsSync(candidate));
        if (found) { filename=found; break; }
      }
    }
    if (!filename) {
      throw new Error(`Файл базы данных не найден. Ожидался: ${cfg.file || 'не задан'}`);
    }
  }
  const sql=`SELECT author,body,time_str,date_str,clock_str,is_own,media_json,reply_author,reply_body,created_at FROM messages WHERE chat_url=? ORDER BY id ASC LIMIT 20000`;
  let db;
  try {
    const Database=require('better-sqlite3');
    db=new Database(filename,{readonly:true,fileMustExist:true});
    try { return db.prepare(sql).all(chatUrl); }
    finally { db.close(); }
  } catch (err) {
    // Node 22+ ships SQLite itself. This fallback avoids breaking chat export
    // when better-sqlite3 was installed for another Node ABI or has no native binding.
    try {
      const { DatabaseSync }=require('node:sqlite');
      db=new DatabaseSync(filename,{readOnly:true});
      try { return db.prepare(sql).all(chatUrl); }
      finally { db.close(); }
    } catch (fallbackErr) {
      throw new Error(`Не удалось открыть SQLite для экспорта: ${fallbackErr.message || err.message}`);
    }
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
async function buildChatExport(chatUrl,title) {
  const rows=await rowsForChat(chatUrl); let lastDate='';
  const messages=rows.map(row=>{
    const date=String(row.date_str||'').trim();
    const separator=date && date!==lastDate ? `<div class="date">${esc(date)}</div>` : ''; if(date) lastDate=date;
    const reply=row.reply_body ? `<div class="reply"><b>${esc(row.reply_author||'Ответ')}</b><br>${esc(row.reply_body)}</div>` : '';
    return `${separator}<div class="row ${row.is_own?'own':''}"><div class="bubble"><b>${esc(row.author||'MAX')}</b>${reply}<div class="body">${esc(row.body||'').replace(/\n/g,'<br>')}</div>${mediaHtml(row.media_json)}<span class="time">${esc(row.clock_str||row.time_str||'')}</span></div></div>`;
  }).join('');
  const html=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><style>body{margin:0;background:#101116;color:#eee;font:15px Arial,sans-serif}.head{position:sticky;top:0;z-index:2;background:#191a20;padding:16px 24px;font-size:20px;font-weight:700}.chat{max-width:1000px;margin:auto;padding:30px 18px;min-height:100vh;background:#111219}.date{text-align:center;margin:22px;color:#ddd}.row{display:flex;margin:7px 0}.row.own{justify-content:flex-end}.bubble{max-width:72%;background:#252731;border-radius:16px;padding:10px 13px;box-shadow:0 1px 2px #0006}.own .bubble{background:#7354d8}.reply{border-left:3px solid #aaa;padding-left:8px;margin:5px 0 8px;opacity:.9}.body{margin-top:4px}.time{float:right;font-size:11px;opacity:.7;margin:7px 0 0 12px}img,video{display:block;max-width:100%;max-height:560px;border-radius:10px;margin-top:8px}audio{width:100%;margin-top:8px}.media{margin-top:8px}a{color:#bcaeff}</style></head><body><header class="head">${esc(title)}</header><main class="chat">${messages||'<div class="date">В локальной истории сообщений пока нет</div>'}</main></body></html>`;
  return {html,count:rows.length};
}
module.exports={buildChatExport};
