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
  await editProfile.waitFor({ state: 'visible', timeout: 10000 });
}

async function saveFirstName(page, firstName) {
  const input = page.getByRole('textbox', { name: /^first name$/i });
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.fill(firstName);
  await input.blur();
  await page.waitForTimeout(300);

  const saveBtn = page.getByRole('button', { name: /^save$/i });
  await saveBtn.waitFor({ state: 'visible', timeout: 5000 });
  await saveBtn.click();

  await page
    .getByRole('button', { name: /^save$/i })
    .waitFor({ state: 'hidden', timeout: 15000 })
    .catch(() => {});

  const error = page.getByText(/only letters allowed/i);
  if (await error.isVisible({ timeout: 500 }).catch(() => false)) {
    throw new Error('MAX принимает только буквы в имени');
  }

  await page.waitForTimeout(800);
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
  rotateDisplayName,
};
