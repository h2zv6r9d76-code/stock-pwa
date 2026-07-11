const DB_NAME="stock-pwa-db";
const STORE="items";
const DB_VERSION=1;
let db,allItems=[],currentPhoto=null,currentView=localStorage.getItem("inventory-view")||"list";
const $=id=>document.getElementById(id);

function openDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=()=>{const d=req.result;if(!d.objectStoreNames.contains(STORE)){const s=d.createObjectStore(STORE,{keyPath:"id"});s.createIndex("updatedAt","updatedAt")}};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
function tx(mode,fn){return new Promise((resolve,reject)=>{const t=db.transaction(STORE,mode),s=t.objectStore(STORE);fn(s);t.oncomplete=resolve;t.onerror=()=>reject(t.error)})}
function getAll(){return new Promise((resolve,reject)=>{const r=db.transaction(STORE).objectStore(STORE).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
function esc(v=""){return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function fmtQty(v){return Number.isInteger(Number(v))?String(Number(v)):String(Number(v))}
function fmtDate(v){return v?new Intl.DateTimeFormat("ja-JP",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(v)):""}

async function refresh(){
  allItems=(await getAll()).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  const cats=[...new Set(allItems.map(x=>x.category).filter(Boolean))].sort();
  const selected=$("categoryFilter").value;
  $("categoryFilter").innerHTML='<option value="">すべての分類</option>'+cats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("");
  $("categoryFilter").value=cats.includes(selected)?selected:"";
  render()
}

function render(){
  const q=$("search").value.trim().toLowerCase(),cat=$("categoryFilter").value;
  const list=allItems.filter(x=>{const text=[x.name,x.category,x.location,x.note,x.unit].join(" ").toLowerCase();return(!q||text.includes(q))&&(!cat||x.category===cat)});
  $("summary").textContent=`${allItems.length}品目`;
  $("clearSearch").hidden=!q;
  $("empty").hidden=list.length!==0;
  $("items").className=`inventory ${currentView}-view`;
  $("items").innerHTML=list.map((x,i)=>`
    <article class="item" data-id="${x.id}" style="animation-delay:${Math.min(i*25,200)}ms">
      ${x.photoDataUrl?`<img class="item-image" src="${x.photoDataUrl}" alt="">`:`<div class="item-image image-placeholder">□</div>`}
      <div class="item-main">
        <h3 class="item-title">${esc(x.name)}</h3>
        <div class="item-sub">${esc([x.category,x.location].filter(Boolean).join("・")||"未分類")}</div>
        <div class="quantity-line">${esc(fmtQty(x.quantity))} ${esc(x.unit||"")}</div>
        <div class="item-sub">更新 ${fmtDate(x.updatedAt)}</div>
      </div>
      <div class="item-actions">
        <div class="stepper">
          <button type="button" class="quick-minus" aria-label="1減らす">−</button>
          <span class="count">${esc(fmtQty(x.quantity))}</span>
          <button type="button" class="quick-plus" aria-label="1増やす">＋</button>
        </div>
      </div>
    </article>`).join("");

  document.querySelectorAll(".item").forEach(el=>{
    el.addEventListener("click",e=>{if(e.target.closest(".stepper"))return;editItem(el.dataset.id)});
    el.querySelector(".quick-minus").addEventListener("click",()=>changeQty(el.dataset.id,-1));
    el.querySelector(".quick-plus").addEventListener("click",()=>changeQty(el.dataset.id,1));
  })
}

async function changeQty(id,delta){
  const x=allItems.find(i=>i.id===id);if(!x)return;
  x.quantity=Math.max(0,Number(x.quantity||0)+delta);
  x.updatedAt=new Date().toISOString();
  await tx("readwrite",s=>s.put(x));
  await refresh()
}

function setView(view){
  currentView=view;localStorage.setItem("inventory-view",view);
  $("listViewBtn").classList.toggle("active",view==="list");
  $("cardViewBtn").classList.toggle("active",view==="card");
  $("listViewBtn").setAttribute("aria-pressed",view==="list");
  $("cardViewBtn").setAttribute("aria-pressed",view==="card");
  render()
}

function resetForm(){
  $("itemForm").reset();$("itemId").value="";$("quantity").value=1;
  $("formTitle").textContent="在庫を追加";$("deleteBtn").hidden=true;
  $("photoPreview").hidden=true;$("photoPreview").removeAttribute("src");currentPhoto=null
}
function editItem(id){
  const x=allItems.find(i=>i.id===id);if(!x)return;resetForm();
  $("itemId").value=x.id;$("name").value=x.name;$("quantity").value=x.quantity;
  $("unit").value=x.unit||"";$("category").value=x.category||"";$("location").value=x.location||"";
  $("note").value=x.note||"";$("formTitle").textContent="在庫を編集";$("deleteBtn").hidden=false;
  currentPhoto=x.photoDataUrl||null;
  if(currentPhoto){$("photoPreview").src=currentPhoto;$("photoPreview").hidden=false}
  $("editor").showModal()
}
async function imageToDataURL(file){
  const img=await createImageBitmap(file),max=1200,scale=Math.min(1,max/Math.max(img.width,img.height));
  const c=document.createElement("canvas");c.width=Math.round(img.width*scale);c.height=Math.round(img.height*scale);
  c.getContext("2d").drawImage(img,0,0,c.width,c.height);img.close();return c.toDataURL("image/jpeg",.8)
}

$("photo").addEventListener("change",async e=>{const f=e.target.files[0];if(!f)return;currentPhoto=await imageToDataURL(f);$("photoPreview").src=currentPhoto;$("photoPreview").hidden=false;$("removePhoto").checked=false});
$("itemForm").addEventListener("submit",async e=>{
  e.preventDefault();const now=new Date().toISOString(),old=allItems.find(x=>x.id===$("itemId").value);
  const item={id:old?.id||crypto.randomUUID(),name:$("name").value.trim(),quantity:Number($("quantity").value),unit:$("unit").value.trim(),category:$("category").value.trim(),location:$("location").value.trim(),note:$("note").value.trim(),photoDataUrl:$("removePhoto").checked?null:currentPhoto,createdAt:old?.createdAt||now,updatedAt:now};
  await tx("readwrite",s=>s.put(item));$("editor").close();await refresh()
});
$("deleteBtn").addEventListener("click",async()=>{const id=$("itemId").value;if(!id||!confirm("この在庫を削除しますか？"))return;await tx("readwrite",s=>s.delete(id));$("editor").close();await refresh()});
$("addBtn").addEventListener("click",()=>{resetForm();$("editor").showModal()});
$("closeBtn").addEventListener("click",()=>$("editor").close());
$("search").addEventListener("input",render);
$("clearSearch").addEventListener("click",()=>{$("search").value="";render();$("search").focus()});
$("categoryFilter").addEventListener("change",render);
$("listViewBtn").addEventListener("click",()=>setView("list"));
$("cardViewBtn").addEventListener("click",()=>setView("card"));
$("formMinus").addEventListener("click",()=>{$("quantity").value=Math.max(0,Number($("quantity").value||0)-1)});
$("formPlus").addEventListener("click",()=>{$("quantity").value=Number($("quantity").value||0)+1});

$("backupBtn").addEventListener("click",async()=>{
  const payload={app:"stock-pwa",version:2,exportedAt:new Date().toISOString(),items:await getAll()};
  const blob=new Blob([JSON.stringify(payload)],{type:"application/json"}),filename=`在庫バックアップ_${new Date().toISOString().slice(0,10)}.json`,file=new File([blob],filename,{type:"application/json"});
  if(navigator.share&&navigator.canShare?.({files:[file]}))await navigator.share({files:[file],title:"在庫バックアップ"});
  else{const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=filename;a.click();URL.revokeObjectURL(a.href)}
});
$("restoreInput").addEventListener("change",async e=>{
  const f=e.target.files[0];if(!f)return;
  try{const data=JSON.parse(await f.text());if(data.app!=="stock-pwa"||!Array.isArray(data.items))throw new Error("形式が違います");if(!confirm("現在の在庫に追加・上書きしますか？"))return;await tx("readwrite",s=>data.items.forEach(i=>s.put(i)));await refresh();alert(`${data.items.length}件を復元しました`)}
  catch(err){alert("復元できませんでした："+err.message)}finally{e.target.value=""}
});
async function showStorage(){if(!navigator.storage?.estimate)return;const e=await navigator.storage.estimate(),used=(e.usage/1024/1024).toFixed(1),quota=(e.quota/1024/1024).toFixed(0),persisted=navigator.storage.persisted?await navigator.storage.persisted():false;$("storageInfo").textContent=`使用量 約${used}MB / 上限目安 約${quota}MB・保護状態：${persisted?"有効":"未確認／無効"}`}
$("storageBtn").addEventListener("click",async()=>{if(!navigator.storage?.persist){alert("この環境では保存保護に対応していません。定期バックアップを利用してください。");return}const ok=await navigator.storage.persist();alert(ok?"保存保護が有効になりました。":"保存保護は許可されませんでした。定期バックアップを利用してください。");showStorage()});

(async()=>{db=await openDB();setView(currentView);await refresh();await showStorage();if("serviceWorker"in navigator)navigator.serviceWorker.register("./sw.js").catch(console.error)})().catch(err=>{console.error(err);alert("起動時にエラーが発生しました："+err.message)});
