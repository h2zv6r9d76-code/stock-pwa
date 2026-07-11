const DB_NAME = "stock-pwa-db";
const STORE = "items";
const DB_VERSION = 1;
let db;
let allItems = [];
let currentPhoto = null;

const $ = (id) => document.getElementById(id);

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        const store = d.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const result = fn(s);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

async function getAll() {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function escapeHTML(v = "") {
  return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function formatDate(v) {
  if (!v) return "";
  return new Intl.DateTimeFormat("ja-JP", {dateStyle:"medium", timeStyle:"short"}).format(new Date(v));
}

async function refresh() {
  allItems = (await getAll()).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  const categories = [...new Set(allItems.map(x => x.category).filter(Boolean))].sort();
  const selected = $("categoryFilter").value;
  $("categoryFilter").innerHTML = '<option value="">すべての分類</option>' +
    categories.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join("");
  $("categoryFilter").value = categories.includes(selected) ? selected : "";
  render();
}

function render() {
  const q = $("search").value.trim().toLowerCase();
  const cat = $("categoryFilter").value;
  const list = allItems.filter(x => {
    const text = [x.name,x.category,x.location,x.note,x.unit].join(" ").toLowerCase();
    return (!q || text.includes(q)) && (!cat || x.category === cat);
  });
  $("summary").textContent = `${allItems.length}品目`;
  $("empty").hidden = list.length !== 0;
  $("items").innerHTML = list.map(x => `
    <article class="card" data-id="${x.id}">
      ${x.photoDataUrl ? `<img src="${x.photoDataUrl}" alt="">` : ""}
      <div class="card-body">
        <h3>${escapeHTML(x.name)}</h3>
        <div class="qty">${escapeHTML(x.quantity)} ${escapeHTML(x.unit || "")}</div>
        ${x.category ? `<div class="meta">分類：${escapeHTML(x.category)}</div>` : ""}
        ${x.location ? `<div class="meta">場所：${escapeHTML(x.location)}</div>` : ""}
        ${x.note ? `<div class="note">${escapeHTML(x.note)}</div>` : ""}
        <div class="meta">更新：${formatDate(x.updatedAt)}</div>
      </div>
    </article>`).join("");
  document.querySelectorAll(".card").forEach(el => el.addEventListener("click", () => editItem(el.dataset.id)));
}

function resetForm() {
  $("itemForm").reset();
  $("itemId").value = "";
  $("quantity").value = 1;
  $("formTitle").textContent = "在庫を追加";
  $("deleteBtn").hidden = true;
  $("photoPreview").hidden = true;
  $("photoPreview").removeAttribute("src");
  currentPhoto = null;
}

function editItem(id) {
  const x = allItems.find(i => i.id === id);
  if (!x) return;
  resetForm();
  $("itemId").value = x.id;
  $("name").value = x.name;
  $("quantity").value = x.quantity;
  $("unit").value = x.unit || "";
  $("category").value = x.category || "";
  $("location").value = x.location || "";
  $("note").value = x.note || "";
  $("formTitle").textContent = "在庫を編集";
  $("deleteBtn").hidden = false;
  currentPhoto = x.photoDataUrl || null;
  if (currentPhoto) {
    $("photoPreview").src = currentPhoto;
    $("photoPreview").hidden = false;
  }
  $("editor").showModal();
}

async function imageToDataURL(file) {
  const img = await createImageBitmap(file);
  const max = 1200;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close();
  return canvas.toDataURL("image/jpeg", 0.8);
}

$("photo").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  currentPhoto = await imageToDataURL(file);
  $("photoPreview").src = currentPhoto;
  $("photoPreview").hidden = false;
  $("removePhoto").checked = false;
});

$("itemForm").addEventListener("submit", async e => {
  e.preventDefault();
  const now = new Date().toISOString();
  const old = allItems.find(x => x.id === $("itemId").value);
  const item = {
    id: old?.id || crypto.randomUUID(),
    name: $("name").value.trim(),
    quantity: Number($("quantity").value),
    unit: $("unit").value.trim(),
    category: $("category").value.trim(),
    location: $("location").value.trim(),
    note: $("note").value.trim(),
    photoDataUrl: $("removePhoto").checked ? null : currentPhoto,
    createdAt: old?.createdAt || now,
    updatedAt: now
  };
  await tx("readwrite", s => s.put(item));
  $("editor").close();
  await refresh();
});

$("deleteBtn").addEventListener("click", async () => {
  const id = $("itemId").value;
  if (!id || !confirm("この在庫を削除しますか？")) return;
  await tx("readwrite", s => s.delete(id));
  $("editor").close();
  await refresh();
});

$("addBtn").addEventListener("click", () => { resetForm(); $("editor").showModal(); });
$("closeBtn").addEventListener("click", () => $("editor").close());
$("search").addEventListener("input", render);
$("categoryFilter").addEventListener("change", render);

$("backupBtn").addEventListener("click", async () => {
  const payload = {
    app: "stock-pwa",
    version: 1,
    exportedAt: new Date().toISOString(),
    items: await getAll()
  };
  const blob = new Blob([JSON.stringify(payload)], {type:"application/json"});
  const filename = `在庫バックアップ_${new Date().toISOString().slice(0,10)}.json`;
  const file = new File([blob], filename, {type:"application/json"});
  if (navigator.share && navigator.canShare?.({files:[file]})) {
    await navigator.share({files:[file], title:"在庫バックアップ"});
  } else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }
});

$("restoreInput").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "stock-pwa" || !Array.isArray(data.items)) throw new Error("形式が違います");
    const mode = confirm("OK：現在の在庫に追加・上書き\nキャンセル：復元を中止");
    if (!mode) return;
    await tx("readwrite", store => data.items.forEach(item => store.put(item)));
    await refresh();
    alert(`${data.items.length}件を復元しました`);
  } catch (err) {
    alert("復元できませんでした：" + err.message);
  } finally {
    e.target.value = "";
  }
});

async function showStorage() {
  if (!navigator.storage?.estimate) return;
  const e = await navigator.storage.estimate();
  const used = (e.usage / 1024 / 1024).toFixed(1);
  const quota = (e.quota / 1024 / 1024).toFixed(0);
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  $("storageInfo").textContent = `使用量 約${used}MB / 上限目安 約${quota}MB・保護状態：${persisted ? "有効" : "未確認／無効"}`;
}

$("storageBtn").addEventListener("click", async () => {
  if (!navigator.storage?.persist) {
    alert("この環境では保存保護の要求に対応していません。定期バックアップを利用してください。");
    return;
  }
  const ok = await navigator.storage.persist();
  alert(ok ? "保存保護が有効になりました。" : "保存保護は許可されませんでした。定期バックアップを利用してください。");
  showStorage();
});

(async () => {
  db = await openDB();
  await refresh();
  await showStorage();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(console.error);
  }
})().catch(err => {
  console.error(err);
  alert("起動時にエラーが発生しました：" + err.message);
});
