const state = {
  books: [],
  groups: [],
  settings: null,
  automation: null,
  importQueue: { pending: [], completed: [], errors: [], summary: { pendingCount: 0, completedCount: 0, errorCount: 0 } },
  discordConfigured: false,
  discordWebhookCount: 0,
  discordWebhookTotalCount: 0,
  discordWebhookPausedCount: 0,
  discordWebhookUrls: [],
  discordWebhooks: [],
  selectedBookIds: new Set(),
  expandedSeriesKeys: new Set(),
  activeFilter: 'all',
  sortMode: readSavedSortMode()
};

const els = {
  addForm: document.getElementById('addForm'),
  bookInput: document.getElementById('bookInput'),
  addButton: document.getElementById('addButton'),
  checkAllButton: document.getElementById('checkAllButton'),
  refreshButton: document.getElementById('refreshButton'),
  settingsForm: document.getElementById('settingsForm'),
  thresholdInput: document.getElementById('thresholdInput'),
  scheduleDisplay: document.getElementById('scheduleDisplay'),
  batchInput: document.getElementById('batchInput'),
  testNotifyButton: document.getElementById('testNotifyButton'),
  sortInput: document.getElementById('sortInput'),
  selectAllInput: document.getElementById('selectAllInput'),
  deleteSelectedButton: document.getElementById('deleteSelectedButton'),
  message: document.getElementById('message'),
  bookGrid: document.getElementById('bookGrid'),
  template: document.getElementById('bookTemplate'),
  bookCount: document.getElementById('bookCount'),
  dropCount: document.getElementById('dropCount'),
  bestCount: document.getElementById('bestCount'),
  importQueueState: document.getElementById('importQueueState'),
  discordState: document.getElementById('discordState'),
  cronState: document.getElementById('cronState'),
  historyDialog: document.getElementById('historyDialog'),
  historyTitle: document.getElementById('historyTitle'),
  historyChart: document.getElementById('historyChart'),
  closeHistoryButton: document.getElementById('closeHistoryButton'),
  webhookDialog: document.getElementById('webhookDialog'),
  webhookForm: document.getElementById('webhookForm'),
  webhookList: document.getElementById('webhookList'),
  addWebhookButton: document.getElementById('addWebhookButton'),
  saveWebhookButton: document.getElementById('saveWebhookButton'),
  closeWebhookButton: document.getElementById('closeWebhookButton'),
  importQueueDialog: document.getElementById('importQueueDialog'),
  importQueueForm: document.getElementById('importQueueForm'),
  importQueueInput: document.getElementById('importQueueInput'),
  importQueuePendingCount: document.getElementById('importQueuePendingCount'),
  importQueueCompletedCount: document.getElementById('importQueueCompletedCount'),
  importQueueErrorCount: document.getElementById('importQueueErrorCount'),
  importQueueErrors: document.getElementById('importQueueErrors'),
  closeImportQueueButton: document.getElementById('closeImportQueueButton'),
  clearImportQueueButton: document.getElementById('clearImportQueueButton'),
  saveImportQueueButton: document.getElementById('saveImportQueueButton')
};

els.addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(els.addButton, true, '追加中');
  try {
    const data = await api('/api/books', {
      method: 'POST',
      body: { url: els.bookInput.value }
    });
    els.bookInput.value = '';
    setMessage(addResultMessage(data), 'success');
    await load();
  } catch (error) {
    if (error.status === 409) {
      setMessage('既に登録済みです。一覧を更新しました', 'success');
      await loadBooks();
    } else {
      setMessage(error.message, 'error');
    }
  } finally {
    setBusy(els.addButton, false, '追加');
  }
});

els.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = {
    notificationThreshold: Number(els.thresholdInput.value),
    batchSize: Number(els.batchInput.value),
    notifyOnPriceDrop: true,
    notifyOnBestEver: true
  };
  try {
    await api('/api/settings', { method: 'PUT', body: payload });
    setMessage('設定を保存しました', 'success');
    await loadSettings();
  } catch (error) {
    setMessage(error.message, 'error');
  }
});

els.checkAllButton.addEventListener('click', async () => {
  setBusy(els.checkAllButton, true, 'チェック中');
  try {
    const result = await api('/api/check', { method: 'POST' });
    setMessage(`${result.checked}冊をチェックしました`, 'success');
    await loadBooks();
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    setBusy(els.checkAllButton, false, '価格チェック');
  }
});

els.refreshButton.addEventListener('click', load);
els.bookCount.addEventListener('click', () => setBookFilter('all'));
els.bestCount.addEventListener('click', () => setBookFilter(state.activeFilter === 'best' ? 'all' : 'best'));
els.discordState.addEventListener('click', openWebhookDialog);
els.importQueueState.addEventListener('click', openImportQueueDialog);
els.sortInput.value = state.sortMode;
els.sortInput.addEventListener('change', () => {
  state.sortMode = els.sortInput.value;
  saveSortMode(state.sortMode);
  renderBooks();
  renderBulkControls();
});

els.testNotifyButton.addEventListener('click', async () => {
  setBusy(els.testNotifyButton, true, '送信中');
  try {
    const result = await api('/api/notify/test', { method: 'POST' });
    const sentText = result.delivered ? `（${result.delivered}件）` : '';
    setMessage(result.skipped ? 'DISCORD_WEBHOOK_URL が未設定です' : `テスト通知を送信しました${sentText}`, result.skipped ? 'error' : 'success');
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    setBusy(els.testNotifyButton, false, '通知テスト');
  }
});

els.closeHistoryButton.addEventListener('click', () => els.historyDialog.close());
els.closeWebhookButton.addEventListener('click', () => els.webhookDialog.close());
els.closeImportQueueButton.addEventListener('click', () => els.importQueueDialog.close());
els.addWebhookButton.addEventListener('click', () => addWebhookRow('', true));
els.clearImportQueueButton.addEventListener('click', () => {
  els.importQueueInput.value = '';
  els.importQueueInput.focus();
});
els.webhookForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(els.saveWebhookButton, true, '保存中');
  try {
    const entries = collectWebhookEntries();
    const data = await api('/api/webhooks', { method: 'PUT', body: { entries } });
    applyWebhookState(data);
    renderWebhookRows(state.discordWebhooks);
    renderSummary();
    setMessage('Webhookを保存しました', 'success');
    els.webhookDialog.close();
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    setBusy(els.saveWebhookButton, false, '保存');
  }
});
els.importQueueForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(els.saveImportQueueButton, true, '保存中');
  try {
    const data = await api('/api/import-queue', {
      method: 'PUT',
      body: { text: els.importQueueInput.value }
    });
    state.importQueue = data;
    renderImportQueue(data);
    renderSummary();
    setMessage('追加キューを保存しました', 'success');
    els.importQueueDialog.close();
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    setBusy(els.saveImportQueueButton, false, '保存');
  }
});

els.selectAllInput.addEventListener('change', () => {
  state.selectedBookIds = els.selectAllInput.checked ? visibleBookIds() : new Set();
  renderBooks();
  renderBulkControls();
});

els.deleteSelectedButton.addEventListener('click', async () => {
  const ids = [...state.selectedBookIds];
  if (ids.length === 0) return;
  if (!confirm(`${ids.length}冊を削除しますか？`)) return;

  setBusy(els.deleteSelectedButton, true, '削除中');
  try {
    const result = await api('/api/books', { method: 'DELETE', body: { ids } });
    state.selectedBookIds.clear();
    setMessage(`${result.deleted}冊を削除しました`, 'success');
    await loadBooks();
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    setBusy(els.deleteSelectedButton, false, '選択削除');
  }
});

async function load() {
  await Promise.all([loadSettings(), loadBooks()]);
}

async function loadSettings() {
  const data = await api('/api/settings');
  state.settings = data.settings;
  state.automation = data.automation || null;
  state.importQueue = { ...state.importQueue, summary: data.importQueue || state.importQueue.summary };
  state.discordConfigured = data.discordConfigured;
  state.discordWebhookCount = data.discordWebhookCount || 0;
  state.discordWebhookTotalCount = data.discordWebhookTotalCount || state.discordWebhookCount;
  state.discordWebhookPausedCount = data.discordWebhookPausedCount || 0;
  els.thresholdInput.value = String(data.settings.notificationThreshold);
  els.scheduleDisplay.textContent = fixedScheduleLabel(data.settings);
  els.batchInput.value = String(data.settings.batchSize);
  renderSummary();
}

function fixedScheduleLabel(settings = {}) {
  const first = formatScheduleTime(settings.checkExecutionHourJst ?? 3, settings.checkExecutionMinuteJst ?? 54);
  const second = formatScheduleTime(settings.secondCheckExecutionHourJst ?? 15, settings.secondCheckExecutionMinuteJst ?? 54);
  return `${first} / ${second}`;
}

function formatScheduleTime(hour, minute) {
  return `${String(Number(hour || 0)).padStart(2, '0')}:${String(Number(minute || 0)).padStart(2, '0')}`;
}

async function loadBooks() {
  const data = await api('/api/books');
  state.books = data.books;
  state.groups = groupBooks(state.books);
  const bookIds = new Set(state.books.map((book) => book.id));
  state.selectedBookIds = new Set([...state.selectedBookIds].filter((id) => bookIds.has(id)));
  renderBooks();
  renderBulkControls();
  renderSummary();
}

function renderSummary() {
  els.bookCount.textContent = String(state.books.length);
  els.dropCount.textContent = String(state.books.filter(isBelowList).length);
  els.bestCount.textContent = String(state.groups.filter(isGroupAtBestEver).length);
  els.importQueueState.textContent = String(state.importQueue?.summary?.pendingCount || 0);
  els.bookCount.classList.toggle('active', state.activeFilter === 'all');
  els.bookCount.setAttribute('aria-pressed', String(state.activeFilter === 'all'));
  els.bestCount.classList.toggle('active', state.activeFilter === 'best');
  els.bestCount.setAttribute('aria-pressed', String(state.activeFilter === 'best'));
  els.discordState.textContent = discordSummaryText();
  els.discordState.title = 'Webhookを編集';
  els.cronState.textContent = cronSummary(state.automation);
}

function setBookFilter(filter) {
  state.activeFilter = filter;
  state.selectedBookIds.clear();
  renderBooks();
  renderBulkControls();
  renderSummary();
}

async function openWebhookDialog() {
  try {
    const data = await api('/api/webhooks');
    applyWebhookState(data);
    renderWebhookRows(state.discordWebhooks);
    renderSummary();
    els.webhookDialog.showModal();
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

async function openImportQueueDialog() {
  try {
    const data = await api('/api/import-queue');
    state.importQueue = data;
    renderImportQueue(data);
    renderSummary();
    els.importQueueDialog.showModal();
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

function renderImportQueue(data) {
  const pending = data.pending || [];
  const completed = data.completed || [];
  const errors = data.errors || [];
  const summary = data.summary || {
    pendingCount: pending.length,
    completedCount: completed.length,
    errorCount: errors.length
  };
  state.importQueue = { pending, completed, errors, summary };
  els.importQueueInput.value = pending.map((entry) => entry.input).join('\n');
  els.importQueuePendingCount.textContent = String(summary.pendingCount || 0);
  els.importQueueCompletedCount.textContent = String(summary.completedCount || 0);
  els.importQueueErrorCount.textContent = String(summary.errorCount || 0);
  const visibleErrors = errors.slice(-5).reverse();
  els.importQueueErrors.hidden = visibleErrors.length === 0;
  els.importQueueErrors.innerHTML = visibleErrors
    .map((entry) => `<div class="import-queue-error"><strong>${escapeHtml(entry.input)}</strong><br>${escapeHtml(entry.error)}</div>`)
    .join('');
}

function renderWebhookRows(entries) {
  els.webhookList.innerHTML = '';
  const values = entries.length > 0 ? entries : [{ name: '', url: '', enabled: true }];
  for (const entry of values) {
    addWebhookRow(entry, false);
  }
}

function addWebhookRow(entry, focus = false) {
  const webhook = normalizeWebhookEntryForUi(entry);
  const row = document.createElement('div');
  row.className = 'webhook-row';
  row.dataset.enabled = String(webhook.enabled);
  row.innerHTML = `
    <input class="webhook-name-input" type="text" placeholder="名前" value="${escapeHtml(webhook.name)}" aria-label="Webhook名">
    <input class="webhook-url-input" type="url" placeholder="https://discord.com/api/webhooks/..." value="${escapeHtml(webhook.url)}" aria-label="Webhook URL">
    <button class="ghost-button webhook-toggle-button" type="button"></button>
    <button class="danger-button webhook-delete-button" type="button">削除</button>
  `;
  row.querySelector('.webhook-toggle-button').addEventListener('click', () => {
    row.dataset.enabled = row.dataset.enabled === 'false' ? 'true' : 'false';
    syncWebhookRowState(row);
  });
  row.querySelector('.webhook-delete-button').addEventListener('click', () => row.remove());
  syncWebhookRowState(row);
  els.webhookList.append(row);
  if (focus) row.querySelector('.webhook-name-input').focus();
}

function collectWebhookEntries() {
  return [...els.webhookList.querySelectorAll('.webhook-row')]
    .map((row) => ({
      name: row.querySelector('.webhook-name-input')?.value.trim() || '',
      url: row.querySelector('.webhook-url-input')?.value.trim() || '',
      enabled: row.dataset.enabled !== 'false'
    }))
    .filter((entry) => entry.url);
}

function applyWebhookState(data = {}) {
  state.discordWebhooks = webhookEntriesFromPayload(data);
  state.discordWebhookUrls = data.urls || state.discordWebhooks.filter((entry) => entry.enabled).map((entry) => entry.url);
  state.discordWebhookCount = data.count ?? state.discordWebhookUrls.length;
  state.discordWebhookTotalCount = data.totalCount ?? state.discordWebhooks.length;
  state.discordWebhookPausedCount = data.pausedCount ?? Math.max(0, state.discordWebhookTotalCount - state.discordWebhookCount);
  state.discordConfigured = state.discordWebhookCount > 0;
}

function webhookEntriesFromPayload(data = {}) {
  if (Array.isArray(data.entries)) return data.entries.map(normalizeWebhookEntryForUi).filter((entry) => entry.url);
  return (data.urls || []).map((url) => ({ name: '', url, enabled: true }));
}

function normalizeWebhookEntryForUi(entry) {
  if (typeof entry === 'string') return { name: '', url: entry, enabled: true };
  return {
    name: String(entry?.name || ''),
    url: String(entry?.url || ''),
    enabled: entry?.enabled !== false
  };
}

function syncWebhookRowState(row) {
  const enabled = row.dataset.enabled !== 'false';
  const button = row.querySelector('.webhook-toggle-button');
  row.classList.toggle('is-paused', !enabled);
  button.textContent = enabled ? '一時停止' : '再開';
  button.title = enabled ? 'このWebhookを一時停止' : 'このWebhookを再開';
  button.setAttribute('aria-pressed', String(!enabled));
}

function discordSummaryText() {
  if (state.discordWebhookCount > 0) {
    if (state.discordWebhookTotalCount > state.discordWebhookCount) {
      return `設定済み(${state.discordWebhookCount}/${state.discordWebhookTotalCount})`;
    }
    return state.discordWebhookCount > 1 ? `設定済み(${state.discordWebhookCount})` : '設定済み';
  }

  if (state.discordWebhookPausedCount > 0 || state.discordWebhookTotalCount > 0) {
    return `停止中(${state.discordWebhookTotalCount})`;
  }

  return '未設定';
}

function renderBooks() {
  els.bookGrid.innerHTML = '';
  const groups = sortedGroups(filteredGroups());
  if (groups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'book-card';
    empty.innerHTML =
      state.activeFilter === 'best'
        ? '<div class="book-body"><h2 class="book-title">過去最安の本はありません</h2><p class="book-meta">フィルタを解除すると全件を表示します。</p></div>'
        : '<div class="book-body"><h2 class="book-title">まだ本がありません</h2><p class="book-meta">Amazon URLかASINを追加してください。</p></div>';
    els.bookGrid.append(empty);
    renderBulkControls();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const group of groups) {
    if (!group.isSeries) {
      fragment.append(createBookNode(group.books[0]));
      continue;
    }

    fragment.append(createSeriesNode(group));
  }
  els.bookGrid.append(fragment);
}

function filteredGroups() {
  if (state.activeFilter === 'best') return state.groups.filter(isGroupAtBestEver);
  return state.groups;
}

function visibleBookIds() {
  return new Set(filteredGroups().flatMap((group) => group.books.map((book) => book.id)));
}

function createSeriesNode(group) {
  const expanded = state.expandedSeriesKeys.has(group.key);
  const selectedCount = group.books.filter((book) => state.selectedBookIds.has(book.id)).length;
  const firstImage = group.books.find((book) => book.imageUrl)?.imageUrl || '';
  const seriesTotal = seriesTotalLabel(group);
  const registeredCount = group.expectedCount > group.books.length ? `${group.books.length}/${group.expectedCount}冊` : `${group.books.length}冊`;
  const seriesStatus = seriesStatusLabel(group);
  const seriesBadge = isGroupAtBestEver(group) ? '<span class="badge best series-badge">過去最安</span>' : '';
  const section = document.createElement('section');
  section.className = 'series-card';
  section.classList.toggle('expanded', expanded);

  const header = document.createElement('div');
  header.className = 'series-card-header';

  const summary = document.createElement('button');
  summary.className = 'series-summary';
  summary.type = 'button';
  summary.setAttribute('aria-expanded', String(expanded));
  summary.innerHTML = `
    <span class="series-cover">
      ${firstImage ? `<img src="${escapeHtml(firstImage)}" alt="">` : '<span>No Image</span>'}
    </span>
    <span class="series-copy">
      <span class="eyebrow">シリーズ</span>
      <span class="series-title-row">
        <strong>${escapeHtml(group.title)}</strong>
        ${seriesBadge}
      </span>
      <span class="series-total">${escapeHtml(seriesTotal)}</span>
      <span class="book-meta">${escapeHtml(registeredCount)} / ${group.checkedCount}冊確認済み / 最終確認 ${relativeTime(group.lastCheckedAt)} / ${escapeHtml(seriesStatus)} / ${selectedCount}冊選択中</span>
    </span>
    <span class="series-chevron">${expanded ? '閉じる' : '開く'}</span>
  `;
  summary.addEventListener('click', () => {
    if (expanded) state.expandedSeriesKeys.delete(group.key);
    else state.expandedSeriesKeys.add(group.key);
    renderBooks();
  });

  const actions = document.createElement('div');
  actions.className = 'series-actions';

  const selectLabel = document.createElement('label');
  selectLabel.className = 'series-select';
  selectLabel.innerHTML = '<input type="checkbox"><span>シリーズ選択</span>';
  const seriesCheckbox = selectLabel.querySelector('input');
  seriesCheckbox.checked = selectedCount === group.books.length;
  seriesCheckbox.indeterminate = selectedCount > 0 && selectedCount < group.books.length;
  seriesCheckbox.addEventListener('click', (event) => event.stopPropagation());
  seriesCheckbox.addEventListener('change', () => {
    for (const book of group.books) {
      if (seriesCheckbox.checked) state.selectedBookIds.add(book.id);
      else state.selectedBookIds.delete(book.id);
    }
    renderBooks();
    renderBulkControls();
  });

  const deleteButton = document.createElement('button');
  deleteButton.className = 'danger-button';
  deleteButton.type = 'button';
  deleteButton.textContent = 'シリーズ削除';
  deleteButton.addEventListener('click', async () => {
    if (!confirm(`${group.title} をシリーズごと削除しますか？`)) return;
    try {
      await api('/api/series', {
        method: 'DELETE',
        body: {
          seriesKey: group.seriesKey,
          sourceUrl: group.sourceUrl
        }
      });
      for (const book of group.books) state.selectedBookIds.delete(book.id);
      state.expandedSeriesKeys.delete(group.key);
      setMessage('シリーズを削除しました', 'success');
      await loadBooks();
    } catch (err) {
      setMessage(err.message, 'error');
    }
  });

  actions.append(selectLabel, deleteButton);
  header.append(summary, actions);

  const books = document.createElement('div');
  books.className = 'series-books';
  books.hidden = !expanded;
  for (const book of group.books) {
    books.append(createBookNode(book));
  }

  section.append(header, books);
  return section;
}

function createBookNode(book) {
  const node = els.template.content.cloneNode(true);
  const card = node.querySelector('.book-card');
  const cover = node.querySelector('.cover');
  const coverLink = node.querySelector('.cover-link');
  const title = node.querySelector('.book-title');
  const meta = node.querySelector('.book-meta');
  const badge = node.querySelector('.badge');
  const current = node.querySelector('.current-price');
  const lowest = node.querySelector('.lowest-price');
  const checked = node.querySelector('.checked-at');
  const error = node.querySelector('.error-text');
  const amazon = node.querySelector('.amazon-link');
  const history = node.querySelector('.history-button');
  const check = node.querySelector('.check-button');
  const remove = node.querySelector('.delete-button');
  const checkbox = node.querySelector('.book-checkbox');

  card.dataset.bookId = book.id;
  card.classList.toggle('pending', book.currentPrice == null);
  checkbox.checked = state.selectedBookIds.has(book.id);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) state.selectedBookIds.add(book.id);
    else state.selectedBookIds.delete(book.id);
    renderBulkControls();
  });
  cover.src = book.imageUrl || '';
  cover.alt = book.title;
  coverLink.href = book.amazonUrl;
  title.textContent = displayBookTitle(book);
  meta.textContent = [cleanMeta(book.author), cleanMeta(book.publisher), book.asin].filter(Boolean).join(' / ');
  current.textContent = formatPrice(book);
  lowest.textContent = book.lowestEffectivePrice == null ? '-' : yen(book.lowestEffectivePrice);
  checked.textContent = relativeTime(book.lastCheckedAt);
  amazon.href = book.amazonUrl;

  const badgeInfo = badgeFor(book);
  badge.textContent = badgeInfo.label;
  badge.classList.toggle('sale', badgeInfo.tone === 'sale');
  badge.classList.toggle('best', badgeInfo.tone === 'best');

  const visibleError = visibleBookError(book);
  if (visibleError) {
    error.textContent = visibleError;
    error.classList.add('active');
  }

  history.addEventListener('click', () => showHistory(book));
  check.addEventListener('click', async () => {
    setBusy(check, true, '確認中');
    try {
      const result = await api(`/api/books/${book.id}/check`, { method: 'POST' });
      const events = result.events.map((item) => item.type).join(', ');
      setMessage(events ? `${book.title}: ${events}` : `${book.title}: 変化なし`, 'success');
      await loadBooks();
    } catch (err) {
      setMessage(err.message, 'error');
    } finally {
      setBusy(check, false, '再チェック');
    }
  });
  remove.addEventListener('click', async () => {
    if (!confirm(`${book.title} を削除しますか？`)) return;
    try {
      await api(`/api/books/${book.id}`, { method: 'DELETE' });
      state.selectedBookIds.delete(book.id);
      setMessage('削除しました', 'success');
      await loadBooks();
    } catch (err) {
      setMessage(err.message, 'error');
    }
  });

  return node;
}

function renderBulkControls() {
  const visibleIds = visibleBookIds();
  const selected = state.selectedBookIds.size;
  const selectedVisible = [...visibleIds].filter((id) => state.selectedBookIds.has(id)).length;
  const total = visibleIds.size;
  els.deleteSelectedButton.disabled = selected === 0;
  els.selectAllInput.checked = total > 0 && selectedVisible === total;
  els.selectAllInput.indeterminate = selectedVisible > 0 && selectedVisible < total;
  els.deleteSelectedButton.textContent = selected > 0 ? `選択削除 (${selected})` : '選択削除';
}

async function showHistory(book) {
  els.historyTitle.textContent = book.title;
  els.historyChart.textContent = '読み込み中';
  els.historyDialog.showModal();
  try {
    const data = await api(`/api/books/${book.id}/history`);
    renderChart(data.history);
  } catch (error) {
    els.historyChart.textContent = error.message;
  }
}

function renderChart(history) {
  const rows = history.filter((entry) => entry.effectivePrice != null);
  if (rows.length === 0) {
    els.historyChart.textContent = '価格履歴がありません';
    return;
  }

  const width = 720;
  const height = 300;
  const pad = { top: 24, right: 22, bottom: 36, left: 72 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const prices = rows.map((entry) => entry.effectivePrice);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const yMin = Math.max(0, Math.floor(min * 0.9 / 100) * 100);
  const yMax = Math.max(100, Math.ceil(max * 1.1 / 100) * 100);
  const range = yMax - yMin || 1;

  const x = (index) => pad.left + (rows.length === 1 ? chartWidth / 2 : (index / (rows.length - 1)) * chartWidth);
  const y = (price) => pad.top + chartHeight - ((price - yMin) / range) * chartHeight;
  const path = rows.map((entry, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${y(entry.effectivePrice)}`).join(' ');
  const area = `${path} L ${x(rows.length - 1)} ${pad.top + chartHeight} L ${x(0)} ${pad.top + chartHeight} Z`;
  const grid = [];
  const labels = [];

  for (let i = 0; i <= 4; i += 1) {
    const value = Math.round(yMin + (range / 4) * i);
    const yy = y(value);
    grid.push(`<line class="chart-grid" x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}"></line>`);
    labels.push(`<text class="chart-label" x="${pad.left - 8}" y="${yy + 4}" text-anchor="end">${yen(value)}</text>`);
  }

  const points = rows
    .map((entry, index) => `<circle class="chart-point" cx="${x(index)}" cy="${y(entry.effectivePrice)}" r="4"></circle>`)
    .join('');
  const first = new Date(rows[0].checkedAt);
  const last = new Date(rows[rows.length - 1].checkedAt);

  els.historyChart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="価格履歴グラフ">
      ${grid.join('')}
      ${labels.join('')}
      <path class="chart-area" d="${area}"></path>
      <path class="chart-line" d="${path}"></path>
      ${points}
      <text class="chart-label" x="${pad.left}" y="${height - 10}">${dateLabel(first)}</text>
      <text class="chart-label" x="${width - pad.right}" y="${height - 10}" text-anchor="end">${dateLabel(last)}</text>
    </svg>
  `;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.textContent = label;
}

function setMessage(text, tone = '') {
  els.message.textContent = text;
  if (tone) els.message.dataset.tone = tone;
  else delete els.message.dataset.tone;
}

function addResultMessage(data) {
  if (data.mode === 'kindle_series') {
    if (data.imported === 0 && data.skippedDuplicates > 0) {
      const updated = data.updatedDuplicates > 0 ? `、既存${data.updatedDuplicates}冊を補完` : '';
      return `このシリーズは登録済みです（既存${data.skippedDuplicates}冊を確認${updated}）`;
    }
    const skipped = data.skippedDuplicates > 0 ? `、重複${data.skippedDuplicates}冊をスキップ` : '';
    const updated = data.updatedDuplicates > 0 ? `、既存${data.updatedDuplicates}冊を補完` : '';
    const incomplete = Array.isArray(data.errors) && data.errors.some((entry) => /series incomplete/i.test(String(entry)));
    const incompleteText = incomplete ? '（一部未取得。次回以降も補完します）' : '';
    return `シリーズから${data.imported}冊を追加しました${skipped}${updated}${incompleteText}`;
  }

  if (data.book) {
    if (data.imported === 0 && data.skippedDuplicates > 0) {
      return data.updatedDuplicates > 0
        ? `${displayBookTitle(data.book)} は登録済みです。既存データを更新しました`
        : `${displayBookTitle(data.book)} は登録済みです`;
    }
    if (data.book.currentPrice == null || visibleBookError(data.book)) {
      return `${displayBookTitle(data.book)} を追加しました。詳細は次回チェックで再取得します`;
    }
    return `${data.book.title} を追加しました`;
  }

  return `${data.imported || 0}冊を追加しました`;
}

function groupBooks(books) {
  const groups = new Map();

  for (const book of books) {
    const isSeries = isSeriesBook(book);
    const key = isSeries ? book.seriesKey || book.sourceUrl || `series:${book.id}` : `single:${book.id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        seriesKey: book.seriesKey || '',
        sourceUrl: book.sourceUrl || '',
        isSeries,
        title: isSeries ? seriesTitle(book) : book.title,
        expectedCount: 0,
        seriesCompleted: false,
        seriesLastDiscoveredAt: '',
        seriesDiscoveryStatus: '',
        seriesDiscoverySkipReason: '',
        seriesDiscoverySkippedAt: '',
        seriesDiscoveryError: '',
        books: []
      });
    }
    groups.get(key).books.push(book);
  }

  return [...groups.values()].map((group) => {
    group.books.sort(compareBooksWithinGroup);
    group.expectedCount = expectedSeriesCount(group.books);
    group.checkedCount = group.books.filter((book) => book.lastCheckedAt).length;
    group.lastCheckedAt = latestCheckedAt(group.books);
    group.seriesCompleted = group.books.some((book) => book.seriesCompleted);
    group.seriesLastDiscoveredAt = latestSeriesDiscoveredAt(group.books);
    group.seriesDiscoveryStatus = aggregateSeriesDiscoveryStatus(group.books);
    group.seriesDiscoverySkipReason = aggregateSeriesDiscoverySkipReason(group.books);
    group.seriesDiscoverySkippedAt = latestSeriesDiscoverySkippedAt(group.books);
    group.seriesDiscoveryError = latestSeriesDiscoveryError(group.books);
    group.totalMetrics = seriesTotalMetrics(group);
    return group;
  });
}

function isSeriesBook(book) {
  return (
    book.importMode === 'kindle_series' ||
    Boolean(book.seriesKey) ||
    Number(book.seriesExpectedCount || 0) > 1
  );
}

function sortedGroups(groups) {
  if (state.sortMode !== 'total_asc') return groups;
  return [...groups].sort(compareGroupsByTotalPrice);
}

function compareGroupsByTotalPrice(a, b) {
  const am = a.totalMetrics || seriesTotalMetrics(a);
  const bm = b.totalMetrics || seriesTotalMetrics(b);
  const ar = totalPriceSortRank(am);
  const br = totalPriceSortRank(bm);
  if (ar !== br) return ar - br;
  if (am.totalPrice !== bm.totalPrice) return am.totalPrice - bm.totalPrice;
  if (am.effectiveTotal !== bm.effectiveTotal) return am.effectiveTotal - bm.effectiveTotal;
  return String(a.title || '').localeCompare(String(b.title || ''), 'ja');
}

function totalPriceSortRank(metrics) {
  if (metrics.pricedCount === 0) return 2;
  return metrics.complete ? 0 : 1;
}

function expectedSeriesCount(books) {
  const counts = books
    .map((book) => Number(book.seriesExpectedCount) || 0)
    .filter((count) => Number.isFinite(count) && count > 0);
  return Math.max(books.length, ...counts);
}

function latestCheckedAt(books) {
  const times = books
    .map((book) => (book.lastCheckedAt ? new Date(book.lastCheckedAt).getTime() : 0))
    .filter((time) => Number.isFinite(time) && time > 0);
  if (times.length === 0) return '';
  return new Date(Math.max(...times)).toISOString();
}

function latestSeriesDiscoveredAt(books) {
  const times = books
    .map((book) => (book.seriesLastDiscoveredAt ? new Date(book.seriesLastDiscoveredAt).getTime() : 0))
    .filter((time) => Number.isFinite(time) && time > 0);
  if (times.length === 0) return '';
  return new Date(Math.max(...times)).toISOString();
}

function latestSeriesDiscoveryError(books) {
  let latest = null;
  for (const book of books) {
    if (!book.seriesDiscoveryError) continue;
    const rawTime = new Date(book.seriesLastDiscoveredAt || 0).getTime();
    const time = Number.isFinite(rawTime) ? rawTime : 0;
    if (!latest || time > latest.time) latest = { time, error: book.seriesDiscoveryError };
  }
  return latest?.error || '';
}

function aggregateSeriesDiscoveryStatus(books) {
  if (books.some((book) => book.seriesDiscoveryStatus === 'error')) return 'error';
  if (books.some((book) => book.seriesDiscoveryStatus === 'checked')) return 'checked';
  if (books.some((book) => book.seriesDiscoveryStatus === 'skipped')) return 'skipped';
  return '';
}

function aggregateSeriesDiscoverySkipReason(books) {
  if (books.some((book) => book.seriesDiscoverySkipReason === 'completed')) return 'completed';
  return books.find((book) => book.seriesDiscoverySkipReason)?.seriesDiscoverySkipReason || '';
}

function latestSeriesDiscoverySkippedAt(books) {
  const times = books
    .map((book) => (book.seriesDiscoverySkippedAt ? new Date(book.seriesDiscoverySkippedAt).getTime() : 0))
    .filter((time) => Number.isFinite(time) && time > 0);
  if (times.length === 0) return '';
  return new Date(Math.max(...times)).toISOString();
}

function compareBooksWithinGroup(a, b) {
  const av = volumeFromTitle(a.title) || Number(a.volume) || 9999;
  const bv = volumeFromTitle(b.title) || Number(b.volume) || 9999;
  if (av !== bv) return av - bv;
  return a.title.localeCompare(b.title, 'ja');
}

function volumeFromTitle(title) {
  const match = String(title || '').match(/(?:第)?([0-9０-９]+)\s*(?:巻|$)/);
  if (!match) return null;
  return Number(match[1].replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xff10)));
}

function seriesTitle(book) {
  if (book.seriesName) return book.seriesName;
  const cleaned = String(book.title || '')
    .replace(/\s*\(?\d+\)?\s*巻?.*$/, '')
    .replace(/^ASIN\s+[A-Z0-9]{10}$/i, '')
    .trim();
  return cleaned || 'Kindle シリーズ';
}

function displayBookTitle(book) {
  if (!isKindleBookAsin(book.asin)) {
    return `${book.asin}（Kindle版ではありません）`;
  }
  if (/Kindle版(?:ASIN|商品)ではありません/.test(book.lastError || '')) {
    return `${book.asin}（Kindle版ではありません）`;
  }
  if (book.volume && /^ASIN\s+[A-Z0-9]{10}$/i.test(book.title)) {
    return `${book.seriesName || 'Kindle'} ${book.volume}`;
  }
  if (/^ASIN\s+[A-Z0-9]{10}$/i.test(book.title)) {
    if (visibleBookError(book)) return `${book.asin}（要確認）`;
    if (book.currentPrice != null) return book.asin;
    return `${book.asin}（取得待ち）`;
  }
  return book.title;
}

function isKindleBookAsin(asin) {
  return /^B[A-Z0-9]{9}$/i.test(String(asin || ''));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPrice(book) {
  if (book.currentPrice == null) return '-';
  if (book.currentPoints > 0) {
    return `${yen(book.currentPrice)} / ${book.currentPoints.toLocaleString('ja-JP')}pt`;
  }
  return yen(book.effectivePrice ?? book.currentPrice);
}

function seriesTotalLabel(group) {
  const { pricedCount, totalPrice, totalPoints, effectiveTotal, missing, unregistered } =
    group.totalMetrics || seriesTotalMetrics(group);
  if (pricedCount === 0) return '合計 未取得';

  const points = totalPoints > 0 ? ` / ${totalPoints.toLocaleString('ja-JP')}pt（実質 ${yen(effectiveTotal)}）` : '';
  const missingText = missing > 0 ? ` / 未取得${missing}冊` : '';
  const unregisteredText = unregistered > 0 ? ` / 未登録${unregistered}冊` : '';
  return `合計 ${yen(totalPrice)}${points}${missingText}${unregisteredText}`;
}

function seriesTotalMetrics(group) {
  const pricedBooks = group.books.filter((book) => book.currentPrice != null);
  const seriesLowest = observedSeriesLowest(group);
  const totalPrice = pricedBooks.reduce((sum, book) => sum + Number(book.currentPrice || 0), 0);
  const totalPoints = pricedBooks.reduce((sum, book) => sum + Number(book.currentPoints || 0), 0);
  const effectiveTotal = pricedBooks.reduce(
    (sum, book) => sum + Number(book.effectivePrice ?? Math.max(0, (book.currentPrice || 0) - (book.currentPoints || 0))),
    0
  );
  const missing = group.books.length - pricedBooks.length;
  const unregistered = Math.max(0, (group.expectedCount || group.books.length) - group.books.length);

  return {
    pricedCount: pricedBooks.length,
    totalPrice,
    totalPoints,
    effectiveTotal,
    lowestEffectiveTotal: seriesLowest,
    lowestPricedCount: seriesLowest == null ? 0 : group.books.length,
    missing,
    unregistered,
    complete: pricedBooks.length > 0 && missing === 0 && unregistered === 0
  };
}

function observedSeriesLowest(group) {
  const values = group.books
    .map((book) => Number(book.seriesLowestEffectiveTotal))
    .filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

function seriesStatusLabel(group) {
  if (group.seriesCompleted || group.seriesDiscoveryStatus === 'skipped') {
    const reason = group.seriesCompleted || group.seriesDiscoverySkipReason === 'completed' ? '完結' : '対象外';
    return `新刊探索 実行なし（${reason}）`;
  }
  const discovered = group.seriesLastDiscoveredAt ? `新刊探索 ${relativeTime(group.seriesLastDiscoveredAt)}` : '新刊探索 未実行';
  return group.seriesDiscoveryError ? `${discovered}（要確認）` : discovered;
}

function cleanMeta(value) {
  const text = String(value || '')
    .replace(/^フォロー,\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length > 80) return '';
  if (/function|P\.when|A\.declarative|window\.ue|var\s+/i.test(text)) return '';
  return text;
}

function yen(value) {
  return `¥${Number(value).toLocaleString('ja-JP')}`;
}

function relativeTime(value) {
  if (!value) return '未確認';
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(diff / 60000));
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}時間前`;
  const days = Math.round(hours / 24);
  return `${days}日前`;
}

function cronSummary(automation) {
  if (!automation?.lastCronStartedAt && !automation?.lastCronFinishedAt) return '未実行';
  if (automation.lastCronError) return 'エラー';
  const checked = Number(automation.lastCronChecked || 0);
  const added = Number(automation.lastSeriesDiscoveryAdded || 0);
  const time = relativeTime(automation.lastCronFinishedAt || automation.lastCronStartedAt);
  return `${time} / ${checked}冊${added > 0 ? ` / 新刊${added}冊` : ''}`;
}

function dateLabel(date) {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function isBelowList(book) {
  return book.effectivePrice != null && book.listPrice != null && book.effectivePrice < book.listPrice;
}

function isAtBestEver(book) {
  return book.effectivePrice != null && book.lowestEffectivePrice != null && book.effectivePrice <= book.lowestEffectivePrice;
}

function isGroupAtBestEver(group) {
  if (!group.isSeries) return isAtBestEver(group.books[0]);

  const metrics = group.totalMetrics || seriesTotalMetrics(group);
  return (
    metrics.complete &&
    metrics.lowestPricedCount === group.books.length &&
    metrics.effectiveTotal <= metrics.lowestEffectiveTotal
  );
}

function badgeFor(book) {
  if (book.effectivePrice == null) return { label: '未取得', tone: '' };
  if (visibleBookError(book)) return { label: '要確認', tone: '' };
  if (isAtBestEver(book)) return { label: '過去最安', tone: 'best' };
  if (isBelowList(book)) return { label: '値下げ', tone: 'sale' };
  return { label: '通常', tone: '' };
}

function visibleBookError(book) {
  const error = String(book?.lastError || '').trim();
  if (!error) return '';
  if (book.currentPrice != null && isTransientBookError(error) && !isBlockingBookError(error)) return '';
  return error;
}

function isTransientBookError(error) {
  return /(?:価格を取得できませんでした|Amazonにブロック|HTTP\s*(?:429|500|503)|fetch failed|タイムアウト|reader:|商品ページではなくエラーページ)/i.test(String(error || ''));
}

function isBlockingBookError(error) {
  return /(?:HTTP\s*(?:429|503)|Too Many Requests|ServiceUnavailable|サービスが利用できません|Amazonにブロック|captcha|robot check|自動化されたアクセス|ショッピングを続けてください)/i.test(String(error || ''));
}

function readSavedSortMode() {
  try {
    const value = localStorage.getItem('kw_sort_mode');
    return value === 'total_asc' ? value : 'default';
  } catch {
    return 'default';
  }
}

function saveSortMode(value) {
  try {
    localStorage.setItem('kw_sort_mode', value === 'total_asc' ? value : 'default');
  } catch {
    // Sorting still works for the current session if storage is unavailable.
  }
}

load().catch((error) => setMessage(error.message, 'error'));
