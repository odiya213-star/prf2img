import * as pdfjsLib from './vendor/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.mjs';

const files = [];
const input = document.querySelector('#fileInput');
const dropZone = document.querySelector('#dropZone');
const fileList = document.querySelector('#fileList');
const emptyState = document.querySelector('#emptyState');
const convertButton = document.querySelector('#convertBtn');
const clearButton = document.querySelector('#clearBtn');
const status = document.querySelector('#status');

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeName(name) {
  return name.replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || 'pdf';
}

function renderList() {
  fileList.innerHTML = '';
  emptyState.hidden = files.length > 0;
  files.forEach((file, index) => {
    const row = document.createElement('li');
    row.className = 'file-row';
    row.innerHTML = `<span class="pdf-icon">PDF</span><div class="file-info"><div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div><div class="file-meta">${formatBytes(file.size)}</div></div><button class="remove-btn" type="button" aria-label="${escapeHtml(file.name)} 제거" data-index="${index}">×</button>`;
    fileList.append(row);
  });
  convertButton.disabled = files.length === 0;
  clearButton.disabled = files.length === 0;
}

function escapeHtml(text) { return text.replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

function addFiles(selected) {
  const incoming = [...selected].filter(file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
  const seen = new Set(files.map(f => `${f.name}/${f.size}/${f.lastModified}`));
  incoming.forEach(file => { const key = `${file.name}/${file.size}/${file.lastModified}`; if (!seen.has(key)) { files.push(file); seen.add(key); } });
  status.textContent = incoming.length ? `${incoming.length}개 PDF를 추가했습니다.` : 'PDF 파일만 선택할 수 있습니다.';
  renderList();
}

input.addEventListener('change', e => { addFiles(e.target.files); input.value = ''; });
fileList.addEventListener('click', e => { const button = e.target.closest('[data-index]'); if (button) { files.splice(Number(button.dataset.index), 1); status.textContent = ''; renderList(); } });
clearButton.addEventListener('click', () => { files.length = 0; status.textContent = ''; renderList(); });
['dragenter','dragover'].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.add('is-dragging'); }));
['dragleave','drop'].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.remove('is-dragging'); }));
dropZone.addEventListener('drop', event => addFiles(event.dataTransfer.files));

async function imageObjectToPng(image) {
  const width = image.width || image.displayWidth;
  const height = image.height || image.displayHeight;
  if (!width || !height) throw new Error('이미지 크기 정보를 읽을 수 없습니다.');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (image.bitmap) {
    context.drawImage(image.bitmap, 0, 0, width, height);
  } else if (image.data && image.data.length === width * height * 4) {
    context.putImageData(new ImageData(new Uint8ClampedArray(image.data), width, height), 0, 0);
  } else if (image.data && image.data.length === width * height * 3) {
    const pixels = context.createImageData(width, height);
    for (let source = 0, target = 0; source < image.data.length; source += 3, target += 4) {
      pixels.data[target] = image.data[source]; pixels.data[target + 1] = image.data[source + 1]; pixels.data[target + 2] = image.data[source + 2]; pixels.data[target + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
  } else {
    context.drawImage(image, 0, 0, width, height);
  }
  return new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))).arrayBuffer());
}

function pageObject(page, objectId) {
  if (typeof objectId !== 'string') return Promise.resolve(objectId);
  return new Promise((resolve, reject) => {
    try {
      if (page.objs.has(objectId)) resolve(page.objs.get(objectId));
      else page.objs.get(objectId, resolve);
    } catch (error) { reject(error); }
  });
}

async function extractImages(file, report) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const task = pdfjsLib.getDocument({ data: bytes, disableAutoFetch: true, disableStream: true });
  const pdf = await task.promise;
  const output = [];
  const seen = new Set();
  const imageOps = new Set([pdfjsLib.OPS.paintImageXObject, pdfjsLib.OPS.paintJpegXObject, pdfjsLib.OPS.paintInlineImageXObject, pdfjsLib.OPS.paintImageXObjectRepeat]);
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    report(pageNo, pdf.numPages);
    const page = await pdf.getPage(pageNo);
    const operators = await page.getOperatorList();
    for (let i = 0; i < operators.fnArray.length; i++) {
      if (!imageOps.has(operators.fnArray[i])) continue;
      const reference = operators.argsArray[i][0];
      const identity = typeof reference === 'string' ? reference : `inline-${pageNo}-${i}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      try {
        const png = await imageObjectToPng(await pageObject(page, reference));
        output.push({ name: `${safeName(file.name)}/image-${String(output.length + 1).padStart(3, '0')}.png`, data: png });
      } catch (error) { console.warn('이미지 객체를 건너뛰었습니다.', error); }
    }
    page.cleanup();
  }
  await pdf.destroy();
  return output;
}

// Minimal ZIP writer: files are stored (not recompressed), avoiding any server or third-party ZIP service.
const crcTable = (() => { const table = new Uint32Array(256); for (let n=0;n<256;n++) { let c=n; for(let k=0;k<8;k++) c=(c&1)?0xedb88320^(c>>>1):c>>>1; table[n]=c>>>0; } return table; })();
function crc32(data) { let c=0xffffffff; for (const byte of data) c=crcTable[(c^byte)&255]^(c>>>8); return (c^0xffffffff)>>>0; }
function u16(n) { return [n&255,(n>>>8)&255]; } function u32(n) { return [n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255]; }
function zip(entries) {
  const encoder = new TextEncoder(), parts = [], directory = []; let offset = 0;
  const date = new Date(); const dosTime = (date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1); const dosDate = ((date.getFullYear()-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate();
  for (const entry of entries) { const name = encoder.encode(entry.name); const data = entry.data; const crc = crc32(data); const header = new Uint8Array([0x50,0x4b,3,4,20,0,0,0,0,0,...u16(dosTime),...u16(dosDate),...u32(crc),...u32(data.length),...u32(data.length),...u16(name.length),0,0,...name]); parts.push(header,data); directory.push(new Uint8Array([0x50,0x4b,1,2,20,0,20,0,0,0,0,0,...u16(dosTime),...u16(dosDate),...u32(crc),...u32(data.length),...u32(data.length),...u16(name.length),0,0,0,0,0,0,0,0,...u32(offset),...name])); offset += header.length + data.length; }
  const dirLength = directory.reduce((total, part) => total + part.length, 0); const end = new Uint8Array([0x50,0x4b,5,6,0,0,0,0,...u16(entries.length),...u16(entries.length),...u32(dirLength),...u32(offset),0,0]); return new Blob([...parts,...directory,end], { type:'application/zip' });
}

async function pool(items, limit, worker) { let cursor = 0; await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => { while (cursor < items.length) { const item = items[cursor++]; await worker(item, cursor); } })); }

convertButton.addEventListener('click', async () => {
  const selected = [...files]; const results = []; const failures = [];
  convertButton.disabled = true; clearButton.disabled = true; input.disabled = true;
  status.textContent = `${selected.length}개 PDF에서 이미지를 찾는 중입니다…`;
  try {
    await pool(selected, Math.min(2, navigator.hardwareConcurrency || 2), async (file, number) => {
      try { const images = await extractImages(file, (page, total) => status.textContent = `이미지 탐색 중: ${number}/${selected.length} · ${file.name} (${page}/${total}쪽)`); results.push(...images); }
      catch (error) { console.error(error); failures.push(file.name); }
    });
    if (!results.length) throw new Error('이미지를 만들 수 있는 PDF가 없습니다.');
    status.textContent = 'ZIP 파일을 만들고 있습니다…';
    const url = URL.createObjectURL(zip(results)); const link = document.createElement('a'); link.href = url; link.download = `pdf-images-${new Date().toISOString().slice(0,10)}.zip`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.textContent = failures.length ? `${results.length}개 이미지를 저장했습니다. ${failures.length}개 파일은 처리하지 못했습니다.` : `${results.length}개 PNG 이미지를 ZIP으로 다운로드했습니다.`;
  } catch (error) { console.error(error); status.textContent = error.message || '처리 중 문제가 발생했습니다.'; }
  finally { convertButton.disabled = files.length === 0; clearButton.disabled = files.length === 0; input.disabled = false; }
});

renderList();
