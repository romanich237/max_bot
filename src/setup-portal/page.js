function renderSetupPage(token) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Настройка MAX → Telegram</title>
  <style>
    :root { color-scheme: dark; --bg:#0f1419; --card:#1a2332; --line:#2a3a52; --text:#e8eef7; --muted:#9db0c9; --accent:#4f8cff; --ok:#3ecf8e; --err:#ff6b6b; }
    * { box-sizing: border-box; }
    body { margin:0; font:16px/1.5 system-ui,Segoe UI,sans-serif; background:var(--bg); color:var(--text); }
    .wrap { max-width:720px; margin:0 auto; padding:24px 16px 48px; }
    h1 { font-size:1.5rem; margin:0 0 8px; }
    .sub { color:var(--muted); margin-bottom:24px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; margin-bottom:16px; }
    .steps { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px; }
    .step { padding:6px 12px; border-radius:999px; border:1px solid var(--line); color:var(--muted); font-size:.85rem; }
    .step.active { border-color:var(--accent); color:var(--text); background:rgba(79,140,255,.12); }
    .step.done { border-color:var(--ok); color:var(--ok); }
    label { display:block; margin:12px 0 6px; color:var(--muted); font-size:.9rem; }
    input, textarea { width:100%; padding:12px 14px; border-radius:10px; border:1px solid var(--line); background:#0c1118; color:var(--text); }
    textarea { min-height:72px; resize:vertical; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    @media (max-width:600px){ .row { grid-template-columns:1fr; } }
    button { border:0; border-radius:10px; padding:12px 16px; font-weight:600; cursor:pointer; }
    .primary { background:var(--accent); color:#fff; }
    .ghost { background:transparent; color:var(--text); border:1px solid var(--line); }
    .choices { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
    .status { padding:12px 14px; border-radius:10px; background:#0c1118; border:1px solid var(--line); margin-bottom:12px; }
    .err { color:var(--err); }
    .ok { color:var(--ok); }
    .shot { width:100%; border-radius:12px; border:1px solid var(--line); background:#000; }
    .hint { color:var(--muted); font-size:.85rem; margin-top:6px; }
    .hidden { display:none; }
    .checks label { display:flex; align-items:center; gap:8px; margin:8px 0; color:var(--text); }
    .checks input { width:auto; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Настройка MAX → Telegram</h1>
    <p class="sub">Персональная страница установки. Ссылка действует только во время настройки.</p>
    <div class="steps" id="steps"></div>
    <div id="alert" class="status hidden"></div>

    <div class="card" id="panel-telegram">
      <h2>1. Telegram</h2>
      <label>Bot token</label>
      <input id="tgToken" type="password" placeholder="123456:ABC..." autocomplete="off" />
      <label>Chat ID</label>
      <input id="tgChatId" placeholder="7547263007" />
      <p class="hint">Узнать chat ID: напишите боту @userinfobot</p>
      <div style="margin-top:16px"><button class="primary" id="saveTelegram">Проверить и продолжить</button></div>
    </div>

    <div class="card hidden" id="panel-max">
      <h2>2. MAX</h2>
      <label>Ссылка на чат MAX</label>
      <input id="chatUrl" placeholder="https://web.max.ru/-68396892343002" />
      <label>Пароль для входа (если есть)</label>
      <input id="browserPassword" type="password" placeholder="из личного кабинета MAX" autocomplete="off" />
      <div class="checks">
        <label><input type="checkbox" id="profileRotate" /> Ротация имени</label>
        <label><input type="checkbox" id="alwaysOnline" /> Бесконечный онлайн</label>
      </div>
      <label>Имена для ротации (через запятую)</label>
      <input id="profileNames" placeholder="в, ва, вас, вася" />
      <div style="margin-top:16px"><button class="primary" id="saveMax">Сохранить и перейти к входу</button></div>
    </div>

    <div class="card hidden" id="panel-auth">
      <h2>3. Вход в MAX</h2>
      <div id="authStatus" class="status">Выберите способ входа</div>
      <div class="choices" id="authChoices">
        <button class="ghost" data-mode="qr">QR-код</button>
        <button class="ghost" data-mode="phone">Номер телефона</button>
      </div>
      <img id="screenshot" class="shot hidden" alt="Скриншот MAX" />
      <p id="shotCaption" class="hint hidden"></p>
      <div id="authInputBox" class="hidden" style="margin-top:14px">
        <label id="authInputLabel">Ввод</label>
        <input id="authInput" />
        <p id="authInputHint" class="hint"></p>
        <button class="primary" id="sendAuthInput" style="margin-top:12px">Отправить</button>
      </div>
    </div>

    <div class="card hidden" id="panel-done">
      <h2 class="ok">Готово</h2>
      <p id="doneText">Бот запущен. Можно закрыть эту страницу и открыть Telegram.</p>
    </div>
  </div>
  <script>
    const TOKEN = ${JSON.stringify(token)};
    const api = (path, body) => fetch('/api/' + TOKEN + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(r => r.json());

    const panels = ['telegram','max','auth','done'];
    const stepsEl = document.getElementById('steps');
    panels.forEach((name, i) => {
      const el = document.createElement('div');
      el.className = 'step';
      el.dataset.step = name;
      el.textContent = (i+1) + '. ' + ({telegram:'Telegram',max:'MAX',auth:'Вход',done:'Готово'})[name];
      stepsEl.appendChild(el);
    });

    function showPanel(name) {
      panels.forEach(p => {
        document.getElementById('panel-' + p).classList.toggle('hidden', p !== name);
        const step = stepsEl.querySelector('[data-step="' + p + '"]');
        step.classList.toggle('active', p === name);
        const idx = panels.indexOf(name);
        step.classList.toggle('done', panels.indexOf(p) < idx);
      });
    }

    function alertMsg(text, kind) {
      const box = document.getElementById('alert');
      box.textContent = text;
      box.className = 'status ' + (kind || '');
      box.classList.remove('hidden');
    }

    document.getElementById('saveTelegram').onclick = async () => {
      const res = await api('/telegram', {
        token: document.getElementById('tgToken').value.trim(),
        chatId: document.getElementById('tgChatId').value.trim(),
      });
      if (!res.ok) return alertMsg(res.error, 'err');
      alertMsg(res.botUsername ? 'Бот @' + res.botUsername + ' подключён' : 'Telegram сохранён', 'ok');
      showPanel('max');
    };

    document.getElementById('saveMax').onclick = async () => {
      const res = await api('/max', {
        chatUrl: document.getElementById('chatUrl').value.trim(),
        browserPassword: document.getElementById('browserPassword').value,
        profileRotate: document.getElementById('profileRotate').checked,
        alwaysOnline: document.getElementById('alwaysOnline').checked,
        profileNames: document.getElementById('profileNames').value.trim(),
      });
      if (!res.ok) return alertMsg(res.error, 'err');
      alertMsg('Настройки MAX сохранены', 'ok');
      showPanel('auth');
    };

    document.querySelectorAll('[data-mode]').forEach(btn => {
      btn.onclick = async () => {
        const res = await api('/auth/start', { mode: btn.dataset.mode });
        if (!res.ok) alertMsg(res.error, 'err');
      };
    });

    document.getElementById('sendAuthInput').onclick = async () => {
      const res = await api('/auth/input', { value: document.getElementById('authInput').value.trim() });
      if (!res.ok) alertMsg(res.error, 'err');
      else document.getElementById('authInput').value = '';
    };

    async function poll() {
      const st = await api('/status');
      if (st.step === 'telegram') showPanel('telegram');
      else if (st.step === 'max') showPanel('max');
      else if (st.step === 'auth' || st.step === 'finishing') showPanel('auth');
      else if (st.step === 'done') showPanel('done');

      document.getElementById('authStatus').textContent = st.message || '';
      if (st.error) alertMsg(st.error, 'err');

      const choices = document.getElementById('authChoices');
      const inputBox = document.getElementById('authInputBox');
      if (st.waitingInput?.field === 'choice') {
        choices.classList.remove('hidden');
        inputBox.classList.add('hidden');
      } else if (st.waitingInput) {
        choices.classList.add('hidden');
        inputBox.classList.remove('hidden');
        document.getElementById('authInputLabel').textContent = st.waitingInput.label;
        document.getElementById('authInputHint').textContent = st.waitingInput.hint || '';
        const authInput = document.getElementById('authInput');
        authInput.type = st.waitingInput.field === 'password' ? 'password' : (st.waitingInput.field === 'tel' ? 'tel' : 'text');
        authInput.inputMode = st.waitingInput.field === 'tel' ? 'numeric' : 'text';
        authInput.placeholder = st.waitingInput.field === 'tel' && /код|sms/i.test(st.waitingInput.label || '')
          ? '123456'
          : (st.waitingInput.field === 'tel' ? '+79001234567' : '');
      } else if (st.step === 'auth') {
        choices.classList.toggle('hidden', st.hasScreenshot);
        inputBox.classList.add('hidden');
      }

      const img = document.getElementById('screenshot');
      if (st.hasScreenshot) {
        img.src = '/api/' + TOKEN + '/screenshot?t=' + Date.now();
        img.classList.remove('hidden');
        document.getElementById('shotCaption').textContent = st.screenshotCaption || '';
        document.getElementById('shotCaption').classList.remove('hidden');
      }

      if (st.done) {
        showPanel('done');
        if (st.botUsername) document.getElementById('doneText').textContent = 'Бот @' + st.botUsername + ' запущен. Отправьте /menu в Telegram.';
      }
    }

    poll();
    setInterval(poll, 2000);
  </script>
</body>
</html>`;
}

module.exports = { renderSetupPage };
