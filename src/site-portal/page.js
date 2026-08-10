function renderSitePage(token) {
  const maxUrl = `/site/${token}/max/`;
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MAX — вход</title>
  <style>
    :root { color-scheme: dark; --bg:#0f1419; --line:#2a3a52; --text:#e8eef7; --accent:#4f8cff; --ok:#3ecf8e; }
    * { box-sizing: border-box; }
    body { margin:0; font:16px/1.4 system-ui,Segoe UI,sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; }
    header { display:flex; gap:12px; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
    h1 { margin:0; font-size:1.1rem; }
    .actions { display:flex; gap:8px; flex-wrap:wrap; }
    button { border:0; border-radius:10px; padding:10px 14px; font-weight:600; cursor:pointer; }
    .primary { background:var(--accent); color:#fff; }
    .ghost { background:transparent; color:var(--text); border:1px solid var(--line); }
    #status { font-size:.9rem; color:#9db0c9; min-height:1.2em; }
    iframe { flex:1; width:100%; border:0; background:#000; }
    .hint { padding:8px 16px; color:#9db0c9; font-size:.85rem; border-bottom:1px solid var(--line); }
  </style>
</head>
<body>
  <header>
    <h1>MAX в браузере</h1>
    <div class="actions">
      <button class="ghost" id="openPhone">Войти по номеру</button>
      <button class="primary" id="syncBtn">Сохранить сессию в бот</button>
    </div>
  </header>
  <p class="hint">Войдите по номеру телефона прямо здесь — без QR-кода. После входа нажмите «Сохранить сессию в бот».</p>
  <div id="status"></div>
  <iframe id="maxFrame" src="${maxUrl}" allow="clipboard-read; clipboard-write"></iframe>
  <script>
    const TOKEN = ${JSON.stringify(token)};
    const frame = document.getElementById('maxFrame');
    const status = document.getElementById('status');

    document.getElementById('openPhone').onclick = () => {
      frame.src = '/site/' + TOKEN + '/max/';
    };

    document.getElementById('syncBtn').onclick = async () => {
      status.textContent = 'Сохраняю сессию...';
      const res = await fetch('/site/' + TOKEN + '/sync', { method: 'POST' });
      const data = await res.json();
      status.textContent = data.ok
        ? 'Сессия сохранена (' + data.cookies + ' cookies). Вернитесь в Telegram.'
        : ('Ошибка: ' + (data.error || 'unknown'));
      status.style.color = data.ok ? '#3ecf8e' : '#ff6b6b';
    };
  </script>
</body>
</html>`;
}

module.exports = { renderSitePage };
