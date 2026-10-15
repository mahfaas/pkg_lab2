/**
 * app.js — главная логика приложения.
 * Управляет загрузкой файлов, распределением по Worker-пулу,
 * отрисовкой таблицы и прогресс-баром.
 */

'use strict';

// ─── Конфигурация ─────────────────────────────────────────────────────────────
const CONFIG = {
  WORKER_COUNT: Math.max(2, (navigator.hardwareConcurrency || 4) - 1),
  BATCH_SIZE: 64,           // файлов на воркер за раз
  HEADER_READ_BYTES: 65536, // читаем только первые 64KB (достаточно для всех заголовков)
  SUPPORTED_EXT: new Set(['jpg', 'jpeg', 'png', 'bmp', 'gif', 'tif', 'tiff', 'pcx']),
  RENDER_CHUNK: 100,        // строк таблицы за один renderAnimationFrame
};

// ─── Состояние ────────────────────────────────────────────────────────────────
let state = {
  allResults: [],
  filteredResults: [],
  sortCol: 'fileName',
  sortDir: 'asc',
  filterText: '',
  filterStatus: 'all',
  currentPage: 1,
  pageSize: 100,
  workers: [],
  isProcessing: false,
  totalFiles: 0,
  processedFiles: 0,
  startTime: 0,
  // Очередь загрузок: если обработка уже идёт, новые файлы встают сюда и
  // обрабатываются сразу после завершения текущей загрузки (ничего не теряется).
  pendingLoads: [],
};

// ─── DOM элементы ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

let dom = {};

document.addEventListener('DOMContentLoaded', () => {
  dom = {
    dropZone: $('drop-zone'),
    fileInput: $('file-input'),
    folderInput: $('folder-input'),
    btnFiles: $('btn-files'),
    btnFolder: $('btn-folder'),
    btnClear: $('btn-clear'),
    btnExport: $('btn-export'),
    progressSection: $('progress-section'),
    progressBar: $('progress-bar'),
    progressText: $('progress-text'),
    progressStats: $('progress-stats'),
    statsBar: $('stats-bar'),
    totalCount: $('total-count'),
    okCount: $('ok-count'),
    damagedCount: $('damaged-count'),
    spoofedCount: $('spoofed-count'),
    elapsedTime: $('elapsed-time'),
    throughput: $('throughput'),
    tableContainer: $('table-container'),
    tableBody: $('table-body'),
    searchInput: $('search-input'),
    filterStatus: $('filter-status'),
    sortSelect: $('sort-select'),
    pageSizeSelect: $('page-size-select'),
    paginationInfo: $('pagination-info'),
    btnPrev: $('btn-prev'),
    btnNext: $('btn-next'),
    workerCount: $('worker-count'),
    emptyState: $('empty-state'),
    resultSection: $('result-section'),
    themeToggle: $('theme-toggle'),
    modalOverlay: $('modal-overlay'),
    modalTitle: $('modal-title'),
    modalBody: $('modal-body'),
    modalClose: $('modal-close'),
  };

  initEventListeners();
  initWorkers();
  updateWorkerDisplay();
});

// ─── Инициализация воркеров ───────────────────────────────────────────────────
function initWorkers() {
  state.workers = [];
  for (let i = 0; i < CONFIG.WORKER_COUNT; i++) {
    const w = new Worker('./js/worker.js');
    w.busy = false;
    w.onmessage = onWorkerMessage;
    w.onerror = (e) => console.error('Worker error:', e);
    state.workers.push(w);
  }
}

function updateWorkerDisplay() {
  if (dom.workerCount) dom.workerCount.textContent = CONFIG.WORKER_COUNT;
}

// ─── Очередь задач ────────────────────────────────────────────────────────────
let taskQueue = [];
let pendingBatches = 0;
let batchResults = {};
let globalBatchIndex = 0;

function onWorkerMessage(e) {
  const { type, results, batchIndex } = e.data;
  if (type === 'BATCH_DONE') {
    this.busy = false;
    // Сохраняем результаты в порядке batchIndex для сортировки
    batchResults[batchIndex] = results;

    state.processedFiles += results.length;
    pendingBatches--;

    updateProgress();
    renderIncomingResults(results);

    // Диспетчер: если есть незавершённые задачи — отправляем следующий батч
    dispatchNext();

    if (pendingBatches === 0 && taskQueue.length === 0) {
      onAllDone();
    }
  }
}

function dispatchNext() {
  for (const worker of state.workers) {
    if (!worker.busy && taskQueue.length > 0) {
      const batch = taskQueue.shift();
      worker.busy = true;
      const transfers = [];
      for (const f of batch.files) {
        if (f.buffer) transfers.push(f.buffer);
        if (f.tail) transfers.push(f.tail);
      }
      worker.postMessage({ type: 'PROCESS_BATCH', files: batch.files, batchIndex: batch.batchIndex }, transfers);
      pendingBatches++;
    }
  }
}

// ─── Обработка файлов ─────────────────────────────────────────────────────────
// Главная точка входа для загрузки файлов (из кнопки и drag&drop).
// Файлы, отобранные по расширению, ставятся в очередь загрузок. Если обработка
// уже идёт, они дождутся её завершения — это исключает потерю/сброс результатов.
function processFiles(fileList) {
  const supported = [];
  for (const file of fileList) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (CONFIG.SUPPORTED_EXT.has(ext)) supported.push(file);
  }

  if (supported.length === 0) {
    showToast('Нет поддерживаемых файлов изображений', 'warning');
    return;
  }

  state.pendingLoads.push(supported);

  // Если сейчас ничего не обрабатывается — запускаем обработку следующей загрузки.
  if (!state.isProcessing) {
    runNextLoad();
  }
}

// Запускает очередную загрузку из очереди. Результаты НЕ сбрасывают прошлые —
// новые файлы добавляются к уже обработанным. Кнопка «Очистить» сбрасывает всё.
function runNextLoad() {
  if (state.pendingLoads.length === 0) return;

  const supported = state.pendingLoads.shift();
  if (supported.length === 0) { runNextLoad(); return; }

  state.processedFiles = 0;
  state.totalFiles = supported.length;
  state.startTime = performance.now();
  state.isProcessing = true;
  taskQueue = [];
  batchResults = {};
  globalBatchIndex = 0;
  pendingBatches = 0;

  dom.progressSection.classList.remove('hidden');
  dom.emptyState.classList.add('hidden');
  dom.resultSection.classList.remove('hidden');
  // Очищаем <tbody> только при самой первой загрузке; при добавлении файлов — дополняем.
  if (state.allResults.length === 0) dom.tableBody.innerHTML = '';
  dom.statsBar.classList.remove('hidden');
  dom.btnClear.disabled = false;
  dom.btnExport.disabled = true;

  updateProgress();

  // Разбиваем на батчи и читаем заголовки асинхронно.
  const batches = [];
  for (let i = 0; i < supported.length; i += CONFIG.BATCH_SIZE) {
    batches.push(supported.slice(i, i + CONFIG.BATCH_SIZE));
  }

  const run = async () => {
    for (const batch of batches) {
      const batchIdx = globalBatchIndex++;
      const batchFiles = await readBatchHeaders(batch);
      taskQueue.push({ files: batchFiles, batchIndex: batchIdx });
    }
    dispatchNext();
  };
  run();
}

/**
 * Читает только первые HEADER_READ_BYTES байт + последние HEADER_TAIL_BYTES байт
 * каждого файла в батче. Lazy loading — не грузим файлы целиком!
 * Хвост нужен для валидации «концовки» файла (IEND у PNG, EOI у JPEG,
 * Trailer у GIF, VGA-палитра у PCX), которые физически лежат в конце файла.
 */
async function readBatchHeaders(files) {
  const HEADER_TAIL_BYTES = 65536; // последние 64KB — достаточно для любых концовок
  const promises = files.map(file => {
    return new Promise((resolve) => {
      const start = file.slice(0, CONFIG.HEADER_READ_BYTES);
      const endStart = Math.max(0, file.size - HEADER_TAIL_BYTES);
      const end = endStart < CONFIG.HEADER_READ_BYTES ? null : file.slice(endStart, file.size);

      let startBuf = null;
      let endBuf = null;
      let done = 0;
      const maybeResolve = () => {
        if (done === 2) {
          resolve({
            name: file.name,
            ext: '.' + file.name.split('.').pop(),
            size: file.size,
            buffer: startBuf,   // ArrayBuffer (начало)
            tail: endBuf,       // ArrayBuffer (конец) — может быть null
          });
        }
      };

      const r1 = new FileReader();
      r1.onload = (e) => { startBuf = e.target.result; done++; maybeResolve(); };
      r1.onerror = () => { startBuf = new ArrayBuffer(0); done++; maybeResolve(); };
      r1.readAsArrayBuffer(start);

      if (end) {
        const r2 = new FileReader();
        r2.onload = (e) => { endBuf = e.target.result; done++; maybeResolve(); };
        r2.onerror = () => { endBuf = new ArrayBuffer(0); done++; maybeResolve(); };
        r2.readAsArrayBuffer(end);
      } else {
        done++;
      }
    });
  });
  return Promise.all(promises);
}

// ─── Прогресс ─────────────────────────────────────────────────────────────────
function updateProgress() {
  const pct = state.totalFiles > 0 ? (state.processedFiles / state.totalFiles) * 100 : 0;
  dom.progressBar.style.width = pct + '%';
  dom.progressBar.setAttribute('aria-valuenow', Math.round(pct));
  dom.progressText.textContent = `${state.processedFiles} / ${state.totalFiles} файлов (${Math.round(pct)}%)`;

  const elapsed = (performance.now() - state.startTime) / 1000;
  const fps = elapsed > 0 ? Math.round(state.processedFiles / elapsed) : 0;
  dom.progressStats.textContent = `${elapsed.toFixed(1)}с • ${fps} файл/с`;
}

function onAllDone() {
  state.isProcessing = false;
  const elapsed = ((performance.now() - state.startTime) / 1000).toFixed(2);
  const fps = Math.round(state.totalFiles / parseFloat(elapsed));
  dom.elapsedTime.textContent = `${elapsed}с`;
  dom.throughput.textContent = `${fps} файл/с`;

  updateStatsBadges();
  applyFiltersAndSort();
  dom.btnExport.disabled = false;
  dom.progressBar.style.width = '100%';
  dom.progressText.textContent = `✓ Готово: ${state.totalFiles} файлов за ${elapsed}с`;

  showToast(`Обработано ${state.totalFiles} файлов за ${elapsed}с`, 'success');

  // Если во время обработки поступили новые файлы — сразу обрабатываем их.
  if (state.pendingLoads.length > 0) {
    runNextLoad();
  }
}

function updateStatsBadges() {
  const damaged = state.allResults.filter(r => r.damaged || r.error).length;
  const spoofed = state.allResults.filter(r => r.spoofed).length;
  const ok = state.allResults.length - damaged;
  dom.totalCount.textContent = state.allResults.length;
  dom.okCount.textContent = ok;
  dom.damagedCount.textContent = damaged;
  dom.spoofedCount.textContent = spoofed;
}

// ─── Отрисовка результатов ────────────────────────────────────────────────────
function renderIncomingResults(results) {
  state.allResults.push(...results);
  const defaultSort = state.sortCol === 'fileName' && state.sortDir === 'asc';
  if (!state.filterText && state.filterStatus === 'all' && defaultSort) {
    // Быстрая инкрементальная отрисовка новых строк
    appendRowsToTable(results);
  } else {
    // Активны фильтр/сортировка — перерисовываем всю таблицу заново
    applyFiltersAndSort();
  }
  updateStatsBadges();
  dom.paginationInfo.textContent = `${state.allResults.length} записей`;
}

function appendRowsToTable(results) {
  const fragment = document.createDocumentFragment();
  for (const r of results) {
    fragment.appendChild(createRow(r));
  }
  dom.tableBody.appendChild(fragment);
}

function createRow(r) {
  const tr = document.createElement('tr');
  const isError = !!(r.error);
  const isDamaged = !!(r.damaged);
  const isSpoofed = !!(r.spoofed);

  if (isError || isDamaged) tr.classList.add('row-damaged');
  else if (isSpoofed) tr.classList.add('row-spoofed');
  else tr.classList.add('row-ok');

  const status = isError ? '❌ Ошибка' : isDamaged ? '⚠️ Повреждён' : isSpoofed ? '🔄 Подмена' : '✅ OK';
  const statusClass = isError || isDamaged ? 'badge-damaged' : isSpoofed ? 'badge-spoofed' : 'badge-ok';

  const fmt = r.format || r.realFormat || r.declaredExt?.toUpperCase() || '?';
  const w = r.width || '—';
  const h = r.height || '—';
  // DPI: показываем только если значение есть и это не 'N/A'
  const hasDpi = r.dpiX !== null && r.dpiX !== undefined && r.dpiX !== 'N/A';
  const dpi = hasDpi
    ? (r.dpiX === r.dpiY ? `${r.dpiX}` : `${r.dpiX}×${r.dpiY}`)
    : 'N/A';
  const depth = r.bitDepth ? `${r.bitDepth} bpp` : '—';
  const comp = r.compression || '—';
  const size = formatSize(r.fileSize);

  tr.innerHTML = `
    <td class="td-filename" title="${escHtml(r.fileName)}">
      <span class="filename-text">${escHtml(r.fileName)}</span>
    </td>
    <td><span class="badge badge-format">${escHtml(fmt)}</span></td>
    <td>${w !== '—' ? `${w}×${h}` : '—'}</td>
    <td>${escHtml(String(dpi))}</td>
    <td>${escHtml(String(depth))}</td>
    <td class="td-compression" title="${escHtml(String(comp))}">${escHtml(String(comp))}</td>
    <td>${escHtml(size)}</td>
    <td><span class="badge ${statusClass}">${status}</span></td>
    <td><button class="btn-details" data-id="${escHtml(r.fileName)}" aria-label="Подробнее о ${escHtml(r.fileName)}">···</button></td>
  `;

  // Клик на кнопку деталей
  tr.querySelector('.btn-details').addEventListener('click', () => openModal(r));
  return tr;
}

// ─── Сортировка и фильтрация ──────────────────────────────────────────────────
function applyFiltersAndSort() {
  let data = [...state.allResults];

  // Фильтр по тексту
  if (state.filterText) {
    const q = state.filterText.toLowerCase();
    data = data.filter(r => r.fileName.toLowerCase().includes(q) || (r.format || '').toLowerCase().includes(q));
  }

  // Фильтр по статусу
  if (state.filterStatus === 'ok') data = data.filter(r => !r.error && !r.damaged && !r.spoofed);
  else if (state.filterStatus === 'damaged') data = data.filter(r => r.error || r.damaged);
  else if (state.filterStatus === 'spoofed') data = data.filter(r => r.spoofed);

  // Сортировка
  const col = state.sortCol;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  data.sort((a, b) => {
    let va = a[col] ?? '', vb = b[col] ?? '';
    if (col === 'fileSize' || col === 'width' || col === 'height' || col === 'bitDepth') {
      va = Number(va) || 0; vb = Number(vb) || 0;
      return (va - vb) * dir;
    }
    return String(va).localeCompare(String(vb)) * dir;
  });

  state.filteredResults = data;
  state.currentPage = 1;
  renderTable();
}

function renderTable() {
  const pageSize = state.pageSize === 'all' ? state.filteredResults.length : parseInt(state.pageSize);
  const start = (state.currentPage - 1) * pageSize;
  const pageData = state.filteredResults.slice(start, start + pageSize);
  const totalPages = Math.max(1, Math.ceil(state.filteredResults.length / pageSize));

  dom.tableBody.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (const r of pageData) fragment.appendChild(createRow(r));
  dom.tableBody.appendChild(fragment);

  dom.paginationInfo.textContent = `${start + 1}–${Math.min(start + pageSize, state.filteredResults.length)} из ${state.filteredResults.length}`;
  dom.btnPrev.disabled = state.currentPage <= 1;
  dom.btnNext.disabled = state.currentPage >= totalPages;
}

// ─── Модальное окно деталей ───────────────────────────────────────────────────
function openModal(r) {
  dom.modalTitle.textContent = r.fileName;
  const rows = [];

  const add = (label, val, hint) => rows.push({ label, val: val ?? '—', hint: hint || '' });

  add('Формат (реальный)', r.format || r.realFormat);
  add('Объявленное расширение', r.declaredExt);
  add('Ширина', r.width ? `${r.width} px` : '—');
  add('Высота', r.height ? `${r.height} px` : '—');
  add('DPI X', r.dpiX, 'Горизонтальное разрешение (точек на дюйм)');
  add('DPI Y', r.dpiY, 'Вертикальное разрешение (точек на дюйм)');
  add('Глубина цвета', r.bitDepth ? `${r.bitDepth} bpp` : '—', 'Бит на пиксель — определяет максимальное кол-во цветов');
  add('Цветовая модель', r.colorType);
  add('Сжатие', r.compression, 'Алгоритм сжатия, применённый к пиксельным данным');
  add('Размер файла', formatSize(r.fileSize));
  add('Статус', r.damaged ? `⚠️ ${r.damaged}` : r.error ? `❌ ${r.error}` : r.spoofed ? `🔄 Подмена расширения` : '✅ OK');

  if (r.extra) {
    for (const [k, v] of Object.entries(r.extra)) add(k, v);
  }

  dom.modalBody.innerHTML = `
    <table class="detail-table">
      <thead><tr><th>Параметр</th><th>Значение</th><th>Описание</th></tr></thead>
      <tbody>
        ${rows.map(row => `
          <tr>
            <td class="detail-label">${escHtml(row.label)}</td>
            <td class="detail-val">${escHtml(String(row.val))}</td>
            <td class="detail-hint">${escHtml(row.hint)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;

  dom.modalOverlay.classList.add('active');
  dom.modalOverlay.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  dom.modalOverlay.classList.remove('active');
  dom.modalOverlay.setAttribute('aria-hidden', 'true');
}

// ─── Экспорт в CSV ────────────────────────────────────────────────────────────
function exportCSV() {
  const headers = ['Имя файла', 'Формат', 'Ширина', 'Высота', 'DPI X', 'DPI Y', 'Глубина цвета', 'Сжатие', 'Размер', 'Статус', 'Повреждение'];
  const rows = [headers];
  for (const r of state.filteredResults) {
    rows.push([
      r.fileName, r.format || r.realFormat, r.width || '', r.height || '',
      r.dpiX || '', r.dpiY || '', r.bitDepth ? `${r.bitDepth} bpp` : '',
      r.compression || '', r.fileSize || '',
      r.damaged ? 'Повреждён' : r.error ? 'Ошибка' : r.spoofed ? 'Подмена' : 'OK',
      r.damaged || r.error || '',
    ]);
  }

  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `image-meta-${Date.now()}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ─── Сбор файлов из drag&drop (файлы + рекурсивный обход папок) ───────────────
// Используем File System Access API (webkitGetAsEntry): папки разворачиваются
// рекурсивно, поэтому можно перетащить каталог с десятками тысяч файлов.
function collectDroppedFiles(dt) {
  return new Promise(async (resolve) => {
    try {
      const items = dt.items;
      if (!items || !items.length) {
        // Fallback: браузер уже дал готовый список файлов
        resolve(Array.from(dt.files));
        return;
      }
      const entries = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry) entries.push(entry);
        else if (item.getAsFile) entries.push({ isFile: true, file: (cb) => cb(item.getAsFile()) });
      }
      const files = [];

      const readAllDirEntries = (dirReader) => new Promise((res) => {
        const acc = [];
        const next = () => {
          dirReader.readEntries((batch) => {
            if (!batch.length) { res(acc); return; }
            acc.push(...batch);
            next();
          }, () => res(acc));
        };
        next();
      });

      const walk = async (entry) => {
        if (entry.isFile) {
          await new Promise((res) => entry.file((f) => { files.push(f); res(); }, () => res()));
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          const batch = await readAllDirEntries(reader);
          for (const child of batch) await walk(child);
        }
      };

      for (const entry of entries) await walk(entry);
      resolve(files);
    } catch (err) {
      console.error('collectDroppedFiles error:', err);
      resolve(Array.from(dt.files));
    }
  });
}

// ─── UI — обработчики событий ─────────────────────────────────────────────────
function initEventListeners() {
  // Drag & Drop
  dom.dropZone.addEventListener('dragover', e => { e.preventDefault(); dom.dropZone.classList.add('drag-over'); });
  dom.dropZone.addEventListener('dragleave', () => dom.dropZone.classList.remove('drag-over'));
  dom.dropZone.addEventListener('drop', async e => {
    e.preventDefault();
    dom.dropZone.classList.remove('drag-over');
    const files = await collectDroppedFiles(e.dataTransfer);
    if (files.length) processFiles(files);
  });

  dom.dropZone.addEventListener('click', () => dom.fileInput.click());

  // Выбор файлов (или папки через drag&drop — браузер сам разворачивает файлы из папки).
  // fileInput.value сбрасывается здесь, чтобы повторный выбор того же файла снова срабатывал.
  dom.fileInput.addEventListener('change', e => {
    if (e.target.files.length) processFiles(e.target.files);
    e.target.value = '';
  });

  dom.btnFiles.addEventListener('click', (e) => { e.stopPropagation(); dom.fileInput.click(); });

  // Выбор целой папки: webkitdirectory раскрывает каталог рекурсивно и отдаёт
  // все файлы (с их относительными путями). processFiles отфильтрует по расширению.
  dom.folderInput.addEventListener('change', e => {
    if (e.target.files.length) processFiles(e.target.files);
    e.target.value = '';
  });

  dom.btnFolder.addEventListener('click', (e) => { e.stopPropagation(); dom.folderInput.click(); });

  // Очистка: сбрасываем всё, включая очередь отложенных загрузок, чтобы после
  // очистки не всплыли файлы, поставленные в очередь во время обработки.
  dom.btnClear.addEventListener('click', () => {
    state.allResults = [];
    state.filteredResults = [];
    state.pendingLoads = [];
    dom.tableBody.innerHTML = '';
    dom.emptyState.classList.remove('hidden');
    dom.resultSection.classList.add('hidden');
    dom.progressSection.classList.add('hidden');
    dom.statsBar.classList.add('hidden');
    dom.btnClear.disabled = true;
    dom.btnExport.disabled = true;
    dom.fileInput.value = '';
    state.isProcessing = false;
  });

  dom.btnExport.addEventListener('click', exportCSV);

  // Поиск
  let searchTimer;
  dom.searchInput.addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filterText = e.target.value.trim();
      applyFiltersAndSort();
    }, 300);
  });

  dom.filterStatus.addEventListener('change', e => {
    state.filterStatus = e.target.value;
    applyFiltersAndSort();
  });

  dom.sortSelect.addEventListener('change', e => {
    const [col, dir] = e.target.value.split(':');
    state.sortCol = col;
    state.sortDir = dir;
    applyFiltersAndSort();
  });

  dom.pageSizeSelect.addEventListener('change', e => {
    state.pageSize = e.target.value;
    state.currentPage = 1;
    renderTable();
  });

  dom.btnPrev.addEventListener('click', () => { state.currentPage--; renderTable(); });
  dom.btnNext.addEventListener('click', () => { state.currentPage++; renderTable(); });

  // Модальное окно
  dom.modalClose.addEventListener('click', closeModal);
  dom.modalOverlay.addEventListener('click', e => { if (e.target === dom.modalOverlay) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // Тема
  dom.themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('light-theme');
    dom.themeToggle.textContent = document.body.classList.contains('light-theme') ? '🌙' : '☀️';
  });
}

// ─── Утилиты ──────────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} МБ`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-show'));
  setTimeout(() => {
    toast.classList.remove('toast-show');
    setTimeout(() => toast.remove(), 400);
  }, 3500);
}
