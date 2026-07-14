const DB_NAME="stock-pwa-db",STORE="items",DB_VERSION=1;
const SYNC_API="https://stock-pwa-api.h2zv6r9d76.workers.dev/v1/sync";
let db,allItems=[],currentPhoto=null,currentView=localStorage.getItem("inventory-view")||"list",lastDeleted=null,toastTimer=null,syncBusy=false;
const $=id=>document.getElementById(id);
const esc=(v="")=>String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtQty=v=>Number.isInteger(Number(v))?String(Number(v)):String(Number(v));
const fmtDate=v=>v?new Intl.DateTimeFormat("ja-JP",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(v)):"";
const keywordDictionary={
  "ネジ":["ねじ","ビス","ボルト","工具","DIY","固定"],"ビス":["ネジ","ねじ","ボルト","工具","DIY","固定"],
  "ドライバー":["工具","ネジ","ねじ","ビス","DIY","修理"],"レンチ":["工具","ボルト","ナット","DIY","修理"],
  "洗剤":["日用品","掃除","洗濯","詰め替え"],"電池":["乾電池","バッテリー","家電","予備"],
  "ケーブル":["コード","充電","USB","家電"],"フィラメント":["3Dプリンター","PLA","PETG","造形"],
  "薬":["医薬品","常備薬","服用","救急箱"]
};

function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=()=>{const d=r.result;if(!d.objectStoreNames.contains(STORE)){const s=d.createObjectStore(STORE,{keyPath:"id"});s.createIndex("updatedAt","updatedAt")}};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
function tx(mode,fn){return new Promise((resolve,reject)=>{const t=db.transaction(STORE,mode),s=t.objectStore(STORE);fn(s);t.oncomplete=resolve;t.onerror=()=>reject(t.error)})}
function getAll(){return new Promise((resolve,reject)=>{const r=db.transaction(STORE).objectStore(STORE).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}

function cloudSyncEnabled(){return localStorage.getItem("inventory-cloud-sync")==="true"}
function setSyncStatus(text){$("syncStatus").textContent=text}
function updateSyncStatus(){setSyncStatus(cloudSyncEnabled()?"同期中":"オフ")}
function scheduleSync(){if(cloudSyncEnabled())syncNow({quiet:true})}
async function syncNow({quiet=false}={}){
  if(syncBusy||!navigator.onLine)return;
  syncBusy=true;setSyncStatus("同期中…");
  try{
    const local=await getAll();
    const r=await fetch(SYNC_API,{method:"POST",credentials:"include",headers:{"content-type":"application/json"},body:JSON.stringify({items:local})});
    if(r.status===401||r.status===403)throw new Error("Cloudflare Accessへのログインが必要です");
    if(!r.ok)throw new Error("同期サーバーに接続できませんでした");
    const data=await r.json();
    if(!Array.isArray(data.items))throw new Error("同期データの形式が正しくありません");
    await tx("readwrite",s=>data.items.forEach(item=>s.put(item)));
    await refresh();setSyncStatus("同期済み");
    if(!quiet)showToast("クラウド同期が完了しました");
  }catch(err){setSyncStatus("要ログイン");if(!quiet)alert(`同期できませんでした：${err.message}`)}
  finally{syncBusy=false}
}

async function refresh(){
  allItems=(await getAll()).sort((a,b)=>(b.updatedAt||"").localeCompare(a.updatedAt||""));
  const active=allItems.filter(x=>!x.deletedAt);
  const cats=[...new Set(active.map(x=>x.category).filter(Boolean))].sort();
  const selected=$("categoryFilter").value;
  $("categoryFilter").innerHTML='<option value="">すべての分類</option>'+cats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("");
  $("categoryFilter").value=cats.includes(selected)?selected:"";
  render();
}

function render(){
  const q=$("search").value.trim().toLowerCase(),cat=$("categoryFilter").value;
  const active=allItems.filter(x=>!x.deletedAt);
  const trash=allItems.filter(x=>x.deletedAt);
  const list=active.filter(x=>{
    const text=[x.name,x.category,x.location,x.note,x.unit,x.keywords].join(" ").toLowerCase();
    return(!q||text.includes(q))&&(!cat||x.category===cat)
  });
  $("summary").textContent=`${active.length}品目`;
  $("trashCount").textContent=trash.length;
  $("clearSearch").hidden=!q;
  $("empty").hidden=list.length!==0;
  $("items").className=`inventory ${currentView}-view`;
  $("items").innerHTML=list.map(x=>`
    <div class="swipe-row" data-id="${x.id}">
      <div class="swipe-actions"><button type="button" class="swipe-delete">削除</button></div>
      <article class="item">
        ${x.photoDataUrl?`<img class="item-image" src="${x.photoDataUrl}" alt="">`:`<div class="item-image placeholder">□</div>`}
        <div class="item-main">
          <h3 class="item-title">${esc(x.name)}</h3>
          <div class="item-meta">${esc([x.category,x.location].filter(Boolean).join("・")||"未分類")}</div>
          <div class="item-qty">${esc(fmtQty(x.quantity))} ${esc(x.unit||"")}</div>
          <div class="item-meta">更新 ${fmtDate(x.updatedAt)}</div>
        </div>
        <div class="quick">
          <button class="minus" type="button">−</button>
          <span>${esc(fmtQty(x.quantity))}</span>
          <button class="plus" type="button">＋</button>
        </div>
      </article>
    </div>`).join("");
  document.querySelectorAll(".swipe-row").forEach(setupSwipeRow);
}

function setupSwipeRow(row){
  const item=row.querySelector(".item"),id=row.dataset.id;
  let startX=0,startY=0,lastX=0,dragging=false,horizontal=false,opened=false,suppressClick=false;
  const reveal=104;

  const setX=(x,animate=false)=>{
    item.classList.toggle("dragging",!animate);
    item.style.transform=`translate3d(${x}px,0,0)`;
    if(animate)requestAnimationFrame(()=>item.classList.remove("dragging"));
  };
  const close=()=>{opened=false;setX(0,true)};
  const open=()=>{opened=true;setX(-reveal,true)};

  item.addEventListener("touchstart",e=>{
    if(e.touches.length!==1)return;
    const t=e.touches[0];
    startX=lastX=t.clientX;startY=t.clientY;
    dragging=true;horizontal=false;suppressClick=false;
    item.classList.add("dragging");
  },{passive:true});

  item.addEventListener("touchmove",e=>{
    if(!dragging||e.touches.length!==1)return;
    const t=e.touches[0],dx=t.clientX-startX,dy=t.clientY-startY;
    lastX=t.clientX;
    if(!horizontal){
      if(Math.abs(dx)<8&&Math.abs(dy)<8)return;
      if(Math.abs(dy)>Math.abs(dx)){dragging=false;item.classList.remove("dragging");return}
      horizontal=true;suppressClick=true;
    }
    e.preventDefault();
    let base=opened?-reveal:0;
    let x=base+dx;
    x=Math.min(0,Math.max(-220,x));
    setX(x,false);
  },{passive:false});

  item.addEventListener("touchend",async()=>{
    if(!dragging&&!horizontal)return;
    const dx=lastX-startX;
    dragging=false;item.classList.remove("dragging");
    if(horizontal){
      if((opened?-reveal:0)+dx<-170){
        item.style.transform="translate3d(-110%,0,0)";
        await new Promise(r=>setTimeout(r,180));
        await moveToTrash(id,true);
      }else if((opened?-reveal:0)+dx<-45)open();
      else close();
      setTimeout(()=>suppressClick=false,120);
    }
  });

  item.addEventListener("click",e=>{
    if(suppressClick)return;
    if(opened){close();return}
    if(e.target.closest(".quick"))return;
    editItem(id);
  });

  row.querySelector(".minus").addEventListener("click",e=>{e.stopPropagation();changeQty(id,-1)});
  row.querySelector(".plus").addEventListener("click",e=>{e.stopPropagation();changeQty(id,1)});
  row.querySelector(".swipe-delete").addEventListener("click",()=>moveToTrash(id,true));

  // Mouse fallback for desktop testing
  item.addEventListener("mousedown",e=>{
    if(e.button!==0)return;
    startX=lastX=e.clientX;startY=e.clientY;dragging=true;horizontal=false;
    const move=ev=>{
      if(!dragging)return;
      const dx=ev.clientX-startX,dy=ev.clientY-startY;lastX=ev.clientX;
      if(!horizontal){
        if(Math.abs(dx)<5&&Math.abs(dy)<5)return;
        if(Math.abs(dy)>Math.abs(dx)){dragging=false;return}
        horizontal=true;
      }
      setX(Math.min(0,Math.max(-220,(opened?-reveal:0)+dx)),false);
    };
    const up=()=>{
      document.removeEventListener("mousemove",move);document.removeEventListener("mouseup",up);
      const dx=lastX-startX;dragging=false;
      if(horizontal&&((opened?-reveal:0)+dx<-45))open();else close();
    };
    document.addEventListener("mousemove",move);document.addEventListener("mouseup",up);
  });
}

async function changeQty(id,delta){
  const x=allItems.find(i=>i.id===id);if(!x)return;
  x.quantity=Math.max(0,Number(x.quantity||0)+delta);x.updatedAt=new Date().toISOString();
  await tx("readwrite",s=>s.put(x));await refresh();scheduleSync();
}
function setView(v){
  currentView=v;localStorage.setItem("inventory-view",v);
  $("listViewBtn").classList.toggle("active",v==="list");
  $("cardViewBtn").classList.toggle("active",v==="card");
  render();
}
function resetForm(){
  $("itemForm").reset();$("itemId").value="";$("quantity").value=1;$("formTitle").textContent="在庫を追加";
  $("deleteBtn").hidden=true;$("photoPreview").hidden=true;$("photoPreview").removeAttribute("src");currentPhoto=null;
  renderSuggestions();
}
function editItem(id){
  const x=allItems.find(i=>i.id===id);if(!x)return;resetForm();
  $("itemId").value=x.id;$("name").value=x.name;$("quantity").value=x.quantity;$("unit").value=x.unit||"";
  $("category").value=x.category||"";$("location").value=x.location||"";$("note").value=x.note||"";$("keywords").value=x.keywords||"";
  $("formTitle").textContent="在庫を編集";$("deleteBtn").hidden=false;currentPhoto=x.photoDataUrl||null;
  if(currentPhoto){$("photoPreview").src=currentPhoto;$("photoPreview").hidden=false}
  renderSuggestions();$("editor").showModal();
}

function unique(values){return [...new Set(values.map(v=>String(v||"").trim()).filter(Boolean))]}
function addKeyword(word){
  const words=unique($("keywords").value.split(/[,、\n]/));
  if(!words.includes(word))words.push(word);
  $("keywords").value=words.join("、");renderSuggestions();
}
function renderChipList(id,values,onPick){
  const el=$(id),list=unique(values).slice(0,8);
  el.hidden=!list.length;
  el.innerHTML=list.map(v=>`<button class="suggestion-chip" type="button" data-value="${esc(v)}">${esc(v)}</button>`).join("");
  el.querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>onPick(b.dataset.value)));
}
function renderSuggestions(){
  const active=allItems.filter(x=>!x.deletedAt);
  renderChipList("categorySuggestions",active.map(x=>x.category),v=>{$("category").value=v;renderSuggestions()});
  renderChipList("locationSuggestions",active.map(x=>x.location),v=>{$("location").value=v;renderSuggestions()});
  const name=$("name").value.trim(),category=$("category").value.trim();
  const matched=Object.entries(keywordDictionary).filter(([key])=>(name+" "+category).toLowerCase().includes(key.toLowerCase())).flatMap(([,words])=>words);
  const past=active.flatMap(x=>String(x.keywords||"").split(/[,、\n]/));
  const already=unique($("keywords").value.split(/[,、\n]/));
  renderChipList("keywordSuggestions",[...matched,...past].filter(v=>!already.includes(v)),addKeyword);
}
async function imageToDataURL(file){
  const img=await createImageBitmap(file),max=1200,scale=Math.min(1,max/Math.max(img.width,img.height));
  const c=document.createElement("canvas");c.width=Math.round(img.width*scale);c.height=Math.round(img.height*scale);
  c.getContext("2d").drawImage(img,0,0,c.width,c.height);img.close();return c.toDataURL("image/jpeg",.8);
}

async function moveToTrash(id,showUndo=false){
  const x=allItems.find(i=>i.id===id);if(!x)return;
  lastDeleted={...x};x.deletedAt=new Date().toISOString();x.updatedAt=x.deletedAt;
  await tx("readwrite",s=>s.put(x));await refresh();scheduleSync();
  if(showUndo)showToast(`「${x.name}」をゴミ箱へ移動しました`);
}
function hideToast(){
  clearTimeout(toastTimer);
  toastTimer=null;
  $("toast").hidden=true;
  lastDeleted=null;
}
function showToast(text){
  clearTimeout(toastTimer);
  $("toastText").textContent=text;
  $("toast").hidden=false;
  toastTimer=setTimeout(hideToast,5000);
}
async function undoDelete(){
  if(!lastDeleted)return;
  const x={...lastDeleted};
  delete x.deletedAt;
  x.updatedAt=new Date().toISOString();
  await tx("readwrite",s=>s.put(x));
  hideToast();
  await refresh();scheduleSync();
}
async function restoreTrash(id){
  const x=allItems.find(i=>i.id===id);if(!x)return;delete x.deletedAt;x.updatedAt=new Date().toISOString();
  await tx("readwrite",s=>s.put(x));await refresh();renderTrash();scheduleSync();
}
async function permanentDelete(id){
  if(!confirm("完全に削除しますか？元に戻せません。"))return;
  await tx("readwrite",s=>s.delete(id));await refresh();renderTrash();scheduleSync();
}
function renderTrash(){
  const list=allItems.filter(x=>x.deletedAt).sort((a,b)=>b.deletedAt.localeCompare(a.deletedAt));
  $("trashEmpty").hidden=list.length!==0;
  $("trashItems").innerHTML=list.map(x=>`
    <div class="trash-row">
      ${x.photoDataUrl?`<img src="${x.photoDataUrl}" alt="">`:`<div class="trash-placeholder">□</div>`}
      <div class="trash-main">
        <h3 class="trash-title">${esc(x.name)}</h3>
        <div class="trash-meta">削除 ${fmtDate(x.deletedAt)}</div>
        <div class="trash-buttons">
          <button class="restore" data-id="${x.id}">復元</button>
          <button class="permanent" data-id="${x.id}">完全削除</button>
        </div>
      </div>
    </div>`).join("");
  document.querySelectorAll(".restore").forEach(b=>b.addEventListener("click",()=>restoreTrash(b.dataset.id)));
  document.querySelectorAll(".permanent").forEach(b=>b.addEventListener("click",()=>permanentDelete(b.dataset.id)));
}

$("photo").addEventListener("change",async e=>{
  const f=e.target.files[0];if(!f)return;
  try{currentPhoto=await imageToDataURL(f);$("photoPreview").src=currentPhoto;$("photoPreview").hidden=false;$("removePhoto").checked=false}
  catch{alert("画像を読み込めませんでした。")}
  finally{e.target.value=""}
});
$("removePhoto").addEventListener("change",e=>{$("photoPreview").hidden=e.target.checked||!currentPhoto});
$("itemForm").addEventListener("submit",async e=>{
  e.preventDefault();const now=new Date().toISOString(),old=allItems.find(x=>x.id===$("itemId").value);
  const item={id:old?.id||crypto.randomUUID(),name:$("name").value.trim(),quantity:Number($("quantity").value),unit:$("unit").value.trim(),category:$("category").value.trim(),location:$("location").value.trim(),note:$("note").value.trim(),keywords:unique($("keywords").value.split(/[,、\n]/)).join("、"),photoDataUrl:$("removePhoto").checked?null:currentPhoto,createdAt:old?.createdAt||now,updatedAt:now};
  await tx("readwrite",s=>s.put(item));$("editor").close();await refresh();scheduleSync();
});
$("deleteBtn").addEventListener("click",async()=>{const id=$("itemId").value;if(id){await moveToTrash(id,true);$("editor").close()}});
$("addBtn").addEventListener("click",()=>{resetForm();$("editor").showModal()});
$("closeBtn").addEventListener("click",()=>$("editor").close());
$("search").addEventListener("input",render);
$("clearSearch").addEventListener("click",()=>{$("search").value="";render()});
$("categoryFilter").addEventListener("change",render);
$("listViewBtn").addEventListener("click",()=>setView("list"));
$("cardViewBtn").addEventListener("click",()=>setView("card"));
$("formMinus").addEventListener("click",()=>{$("quantity").value=Math.max(0,Number($("quantity").value||0)-1)});
$("formPlus").addEventListener("click",()=>{$("quantity").value=Number($("quantity").value||0)+1});
$("undoBtn").addEventListener("click",undoDelete);
$("trashBtn").addEventListener("click",()=>{renderTrash();$("trashDialog").showModal()});
$("closeTrashBtn").addEventListener("click",()=>$("trashDialog").close());
$("emptyTrashBtn").addEventListener("click",async()=>{
  const trash=allItems.filter(x=>x.deletedAt);if(!trash.length)return;
  if(!confirm(`ゴミ箱の${trash.length}件を完全に削除しますか？`))return;
  await tx("readwrite",s=>trash.forEach(x=>s.delete(x.id)));await refresh();renderTrash();
});
$("backupBtn").addEventListener("click",async()=>{
  const payload={app:"stock-pwa",version:"3.1",exportedAt:new Date().toISOString(),items:await getAll()};
  const blob=new Blob([JSON.stringify(payload)],{type:"application/json"}),name=`在庫バックアップ_${new Date().toISOString().slice(0,10)}.json`,file=new File([blob],name,{type:"application/json"});
  if(navigator.share&&navigator.canShare?.({files:[file]}))await navigator.share({files:[file],title:"在庫バックアップ"});
  else{const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;a.click();URL.revokeObjectURL(a.href)}
});
$("syncBtn").addEventListener("click",async()=>{
  if(!cloudSyncEnabled()){
    if(!confirm("この端末の在庫を、ログインで保護されたクラウドに同期します。続けますか？"))return;
    localStorage.setItem("inventory-cloud-sync","true");
  }
  await syncNow();
});
$("restoreInput").addEventListener("change",async e=>{
  const f=e.target.files[0];if(!f)return;
  try{const data=JSON.parse(await f.text());if(data.app!=="stock-pwa"||!Array.isArray(data.items))throw Error("形式が違います");if(!confirm("現在の在庫に追加・上書きしますか？"))return;await tx("readwrite",s=>data.items.forEach(i=>s.put(i)));await refresh();scheduleSync();alert(`${data.items.length}件を復元しました`)}
  catch(err){alert("復元できませんでした："+err.message)}finally{e.target.value=""}
});
async function showStorage(){
  if(!navigator.storage?.estimate){$("storageInfo").textContent="在庫データはこのiPhone内に保存されています。大切なデータは定期的にバックアップしてください。";return}
  const e=await navigator.storage.estimate(),used=(e.usage/1048576).toFixed(1);
  $("storageInfo").textContent=`在庫データはこのiPhone内に保存中（使用量 約${used}MB）。SafariのWebサイトデータを削除する前に、バックアップを書き出してください。`;
}

["name","category","location","keywords"].forEach(id=>$(id).addEventListener("input",renderSuggestions));

(async()=>{db=await openDB();setView(currentView);await refresh();updateSyncStatus();await showStorage();if("serviceWorker"in navigator)navigator.serviceWorker.register("./sw.js").catch(console.error);window.addEventListener("online",()=>scheduleSync())})().catch(err=>alert("起動エラー："+err.message));
