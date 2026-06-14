const CYRILLIC_LETTERS = 'абвгдежзийклмнопрстуфхцчшщъыьэюя';

function nextDisplayName(options = {}, index = 0) {
  const { mode = 'letter', baseName = '', names = [] } = options;

  if (mode === 'list' && names.length > 0) {
    return names[index % names.length];
  }

  const letter = CYRILLIC_LETTERS[index % CYRILLIC_LETTERS.length];
  return baseName ? `${baseName}${letter}` : letter;
}

async function clickSettings(page) {
  const settings = page.getByRole('button', { name: /^settings$/i });
  if (await settings.isVisible({ timeout: 3000 }).catch(() => false)) {
    await settings.click();
    return;
  }

  const settingsRu = page.getByRole('button', { name: /настройки/i });
  await settingsRu.click({ timeout: 10000 });
}

async function openProfileEditor(page) {
  const profilePanel = page.locator('div.panel div.section div.input').first();
  if (await profilePanel.isVisible({ timeout: 1500 }).catch(() => false)) {
    return;
  }

  const editProfile = page.getByRole('main', { name: /edit profile/i });
  if (await editProfile.isVisible({ timeout: 1000 }).catch(() => false)) {
    return;
  }

  await clickSettings(page);
  await page.waitForTimeout(500);

  const profileBtn = page
    .locator('button')
    .filter({ hasText: /\+\d[\d\s\-()]{8,}/ })
    .first();

  await profileBtn.click({ timeout: 10000 });
  await page
    .locator('div.panel div.section div.input, main[name*="edit profile" i]')
    .first()
    .waitFor({ state: 'visible', timeout: 10000 });
}

async function getProfileNameSection(page, sectionIndex) {
  return page.locator('div.panel div.section').nth(sectionIndex);
}

async function getProfileFirstNameInput(page) {
  const section = await getProfileNameSection(page, 0);
  const nested = section.locator(
    'div.input input, div.input textarea, div.input [contenteditable="true"]'
  );

  if (await nested.first().isVisible({ timeout: 1500 }).catch(() => false)) {
    return nested.first();
  }

  const divInput = section.locator('div.input.input--primary, div.input').first();
  if (await divInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    return divInput;
  }

  const byRole = section.getByRole('textbox', { name: /^(first name|имя)$/i });
  if (await byRole.isVisible({ timeout: 1000 }).catch(() => false)) {
    return byRole.first();
  }

  return section.getByRole('textbox').first();
}

async function getProfileSectionInput(page, sectionIndex) {
  if (sectionIndex === 0) {
    return getProfileFirstNameInput(page);
  }

  const section = await getProfileNameSection(page, sectionIndex);
  const input = section.locator('input:not([type="hidden"]), textarea').first();

  if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
    return input;
  }

  const divInput = section.locator('div.input input, div.input textarea, div.input, div.textarea').first();
  if (await divInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    return divInput;
  }

  const textbox = section.getByRole('textbox').first();
  if (await textbox.isVisible({ timeout: 1500 }).catch(() => false)) {
    return textbox;
  }

  return null;
}

async function readInputValue(input) {
  if (!input) return '';

  const fromDom = await input
    .evaluate((el) => {
      const editable =
        el.matches('input, textarea, [contenteditable="true"]') ?
          el
        : el.querySelector('input, textarea, [contenteditable="true"]');
      const target = editable || el;

      if ('value' in target && String(target.value || '').trim()) {
        return String(target.value).trim();
      }

      const raw = (target.textContent || target.innerText || '').trim();
      return raw
        .replace(/Введено\s+\d+\s+из\s+\d+\s+символов/gi, '')
        .replace(/\d+\s*\/\s*\d+\s*$/g, '')
        .trim();
    })
    .catch(() => '');

  if (fromDom) return fromDom;

  try {
    const value = (await input.inputValue()).trim();
    if (value) return value;
  } catch {
    /* not a regular input */
  }

  return '';
}

async function readProfileFirstNameOnly(page, chatUrl) {
  await openProfileEditor(page);
  await page.waitForTimeout(400);

  const input = await getProfileFirstNameInput(page);
  const firstName = await readInputValue(input);

  await closeProfileEditor(page);

  if (chatUrl) {
    await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(2000);
  }

  return firstName;
}

async function readProfileNames(page, chatUrl) {
  await openProfileEditor(page);
  await page.waitForTimeout(400);

  const firstName = await readInputValue(await getProfileFirstNameInput(page));
  let lastName = '';

  const lastSection = await getProfileNameSection(page, 1);
  const lastNested = lastSection.locator(
    'div.input input, div.input textarea, div.input [contenteditable="true"], div.input'
  );
  if (await lastNested.first().isVisible({ timeout: 1000 }).catch(() => false)) {
    lastName = await readInputValue(lastNested.first());
  }

  await closeProfileEditor(page);

  if (chatUrl) {
    await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(2000);
  }

  return {
    firstName,
    lastName,
    displayName: firstName,
  };
}

async function readProfileFirstName(page, chatUrl) {
  return readProfileFirstNameOnly(page, chatUrl);
}

async function resolveEditableTarget(input) {
  const inner = input.locator('input, textarea, [contenteditable="true"]').first();
  if (await inner.count()) {
    if (await inner.isVisible({ timeout: 300 }).catch(() => false)) {
      return inner;
    }
  }
  return input;
}

async function fillProfileField(page, input, text) {
  const target = await resolveEditableTarget(input);
  await target.waitFor({ state: 'visible', timeout: 10000 });
  await target.click();
  await page.waitForTimeout(200);

  try {
    await target.fill(text);
  } catch {
    await target.evaluate((el, value) => {
      if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
        el.textContent = value;
      } else if ('value' in el) {
        el.value = value;
      } else {
        el.textContent = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, text);
  }

  await target.blur();
  await page.waitForTimeout(300);
}

async function clickProfileSave(page) {
  const saveBtn = page.getByRole('button', { name: /^(save|сохранить)$/i });
  await saveBtn.waitFor({ state: 'visible', timeout: 5000 });
  await saveBtn.click();

  await page
    .getByRole('button', { name: /^(save|сохранить)$/i })
    .waitFor({ state: 'hidden', timeout: 15000 })
    .catch(() => {});

  await page.waitForTimeout(800);
}

async function saveFirstName(page, firstName) {
  const input = await getProfileFirstNameInput(page);
  if (!input) {
    throw new Error('Не найдено поле имени в профиле MAX (section[0]).');
  }

  await fillProfileField(page, input, firstName);

  const error = page.getByText(/only letters allowed|только буквы/i);
  await clickProfileSave(page);

  if (await error.isVisible({ timeout: 500 }).catch(() => false)) {
    throw new Error('MAX принимает только буквы в имени');
  }
}

async function getProfileBioInput(page) {
  const section = page.locator('div.panel div.section').nth(2);
  const nested = section.locator(
    'div.textarea textarea, div.textarea [contenteditable="true"], textarea'
  );

  if (await nested.first().isVisible({ timeout: 1500 }).catch(() => false)) {
    return nested.first();
  }

  const divTextarea = section.locator('div.textarea.textarea--primary, div.textarea').first();
  if (await divTextarea.isVisible({ timeout: 1500 }).catch(() => false)) {
    return divTextarea;
  }

  return null;
}

async function saveProfileBio(page, bioText) {
  const input = await getProfileBioInput(page);
  if (!input) {
    throw new Error('Не найдено поле описания в профиле MAX (section[2] div.textarea).');
  }

  await fillProfileField(page, input, bioText);
  await clickProfileSave(page);
}

async function rotateProfileBio(page, chatUrl, options = {}) {
  const { renderBioDescription } = require('./profile-bio');
  const bioText = await renderBioDescription(options);
  const preview = bioText.length > 80 ? `${bioText.slice(0, 80)}…` : bioText;
  console.log(`Обновление описания MAX (${bioText.length} симв.): «${preview}»`);

  await openProfileEditor(page);
  await saveProfileBio(page, bioText);
  await closeProfileEditor(page);

  await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2000);

  return bioText;
}

async function closeProfileEditor(page) {
  const back = page.getByRole('button', { name: /^(go back|назад)$/i });
  if (await back.isVisible({ timeout: 2000 }).catch(() => false)) {
    await back.click();
    await page.waitForTimeout(400);
  }

  const chats = page.getByRole('button', { name: /^(chats|чаты)$/i });
  if (await chats.isVisible({ timeout: 2000 }).catch(() => false)) {
    await chats.click();
    await page.waitForTimeout(400);
  }
}

async function rotateDisplayName(page, chatUrl, options = {}) {
  const firstName = nextDisplayName(options, options._index ?? 0);
  console.log(`Смена имени в MAX → «${firstName}»`);

  await openProfileEditor(page);
  await saveFirstName(page, firstName);
  await closeProfileEditor(page);

  await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2000);

  return firstName;
}

module.exports = {
  nextDisplayName,
  readProfileFirstNameOnly,
  readProfileFirstName,
  readProfileNames,
  rotateDisplayName,
  rotateProfileBio,
  saveProfileBio,
};
