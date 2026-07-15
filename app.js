const DB_NAME="stock-pwa-db",STORE="items",SETTINGS_STORE="settings",DB_VERSION=2;
const SYNC_ORIGIN="https://stock-pwa-api.h2zv6r9d76.workers.dev";
const MAX_ITEMS_PER_SYNC=500,MAX_ITEM_BYTES=900000,MAX_BACKUP_BYTES=15000000,MAX_IMAGE_CHARS=800000,BACKUP_KDF_ITERATIONS=250000;
let db,allItems=[],currentPhoto=null,currentView=localStorage.getItem("inventory-view")||"list",currentSort=localStorage.getItem("inventory-sort")||"updatedAt",currentSortOrder=localStorage.getItem("inventory-sort-order")||"desc",lastDeleted=null,toastTimer=null,syncBusy=false,scannerStream=null,scannerTimer=null,barcodeDetector=null,vaultKey=null,pendingBackup=null;
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

function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=()=>{const d=r.result;if(!d.objectStoreNames.contains(STORE)){const s=d.createObjectStore(STORE,{keyPath:"id"});s.createIndex("updatedAt","updatedAt")}if(!d.objectStoreNames.contains(SETTINGS_STORE))d.createObjectStore(SETTINGS_STORE)};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
function tx(mode,fn){return new Promise((resolve,reject)=>{const t=db.transaction(STORE,mode),s=t.objectStore(STORE);fn(s);t.oncomplete=resolve;t.onerror=()=>reject(t.error)})}
function getAll(){return new Promise((resolve,reject)=>{const r=db.transaction(STORE).objectStore(STORE).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
function settingGet(key){return new Promise((resolve,reject)=>{const r=db.transaction(SETTINGS_STORE).objectStore(SETTINGS_STORE).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
function settingSet(key,value){return new Promise((resolve,reject)=>{const t=db.transaction(SETTINGS_STORE,"readwrite");t.objectStore(SETTINGS_STORE).put(value,key);t.oncomplete=resolve;t.onerror=()=>reject(t.error)})}

function bytesToBase64(bytes){let text="";for(let i=0;i<bytes.length;i+=0x8000)text+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(text)}
function base64ToBytes(value){const text=atob(value),bytes=new Uint8Array(text.length);for(let i=0;i<text.length;i++)bytes[i]=text.charCodeAt(i);return bytes}
function validImage(value){return !value||(typeof value==="string"&&value.length<=MAX_IMAGE_CHARS&&/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))}
function validDate(value){return typeof value==="string"&&!Number.isNaN(Date.parse(value))}
function validInventoryItem(item){
  if(!item||typeof item!=="object"||typeof item.id!=="string"||item.id.length<1||item.id.length>100||typeof item.name!=="string"||item.name.length<1||item.name.length>100||!validDate(item.updatedAt)||!Number.isFinite(Number(item.quantity))||Number(item.quantity)<0)return false;
  const limits={barcode:128,unit:20,category:50,location:100,note:500,keywords:300};
  return Object.entries(limits).every(([key,max])=>(item[key]===undefined||typeof item[key]==="string"&&item[key].length<=max))&&validImage(item.photoDataUrl);
}
async function deriveAesKey(password,salt,iterations=BACKUP_KDF_ITERATIONS){
  const material=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveKey"]);
  return crypto.subtle.deriveKey({name:"PBKDF2",salt,iterations,hash:"SHA-256"},material,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
async function deriveAndStoreVaultKey(password){
  vaultKey=await deriveAesKey(password,new TextEncoder().encode("stock-pwa-sync-v1|"+SYNC_ORIGIN));
  await settingSet("vaultKey",vaultKey);
}
async function encryptValue(value,key,maxBytes=MAX_ITEM_BYTES){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const plain=new TextEncoder().encode(JSON.stringify(value));
  if(plain.byteLength>maxBytes)throw new Error("データが大きすぎます。画像を小さくしてください");
  const cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,plain);
  return {iv:bytesToBase64(iv),ciphertext:bytesToBase64(new Uint8Array(cipher))};
}
async function decryptValue(envelope,key){
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:base64ToBytes(envelope.iv)},key,base64ToBytes(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plain));
}

function cloudSyncEnabled(){return localStorage.getItem("inventory-cloud-sync")==="true"}
function syncToken(){return localStorage.getItem("inventory-sync-token")}
function setSyncStatus(text){$("syncStatus").textContent=text}
function updateSyncStatus(){setSyncStatus(cloudSyncEnabled()?(syncToken()&&vaultKey?"同期済み":"ログイン"):'オフ')}
function scheduleSync(){if(cloudSyncEnabled()&&syncToken()&&vaultKey)syncNow({quiet:true})}
function openLogin(){$("syncPassword").value="";$("loginDialog").showModal();$("syncPassword").focus()}
async function encryptSyncItem(item){
  if(!validInventoryItem(item))throw new Error("在庫データの形式が正しくありません");
  const encrypted=await encryptValue(item,vaultKey);
  // name は旧Workerとの短期間の互換用ダミー。実際の品名は ciphertext 内だけに入る。
  return {id:item.id,name:"",updatedAt:item.updatedAt,encrypted:true,...encrypted};
}
async function decryptSyncItem(envelope){
  // 旧形式のデータは最初の同期で新しい暗号化形式に移行する。
  const item=envelope?.encrypted===true?await decryptValue(envelope,vaultKey):envelope;
  if(!validInventoryItem(item))throw new Error("同期データの形式が正しくありません");
  return item;
}
async function syncNow({quiet=false}={}){
  if(syncBusy||!navigator.onLine)return;
  if(!syncToken()){setSyncStatus("ログイン");if(!quiet)openLogin();return}
  if(!vaultKey){setSyncStatus("ログイン");if(!quiet){alert("安全な同期へ更新されたため、パスワードをもう一度入力してください。");openLogin()}return}
  syncBusy=true;setSyncStatus("同期中…");
  try{
    const local=await getAll();
    if(local.length>MAX_ITEMS_PER_SYNC)throw new Error("同期できる品目数の上限を超えています");
    const items=await Promise.all(local.map(encryptSyncItem));
    const r=await fetch(`${SYNC_ORIGIN}/v1/sync`,{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${syncToken()}`},body:JSON.stringify({items})});
    if(r.status===401||r.status===403){localStorage.removeItem("inventory-sync-token");throw new Error("ログインの有効期限が切れました")}
    if(!r.ok)throw new Error("同期サーバーに接続できませんでした");
    const data=await r.json();
    if(!Array.isArray(data.items)||data.items.length>MAX_ITEMS_PER_SYNC)throw new Error("同期データの形式が正しくありません");
    const decoded=await Promise.all(data.items.map(decryptSyncItem));
    await tx("readwrite",s=>decoded.forEach(item=>s.put(item)));
    await refresh();setSyncStatus("同期済み");
    if(!quiet)showToast("クラウド同期が完了しました");
  }catch(err){setSyncStatus(syncToken()?"再試行":"ログイン");if(!quiet)alert(`同期できませんでした：${err.message}`)}
  finally{syncBusy=false}
}

async function refresh(){
  allItems=await getAll();
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
    const text=[x.name,x.barcode,x.category,x.location,x.note,x.unit,x.keywords].join(" ").toLowerCase();
    return(!q||text.includes(q))&&(!cat||x.category===cat)
  }).sort((a,b)=>{
    const aValue=currentSort==="name"?(a.name||""):(a[currentSort]||"");
    const bValue=currentSort==="name"?(b.name||""):(b[currentSort]||"");
    const result=String(aValue).localeCompare(String(bValue),"ja");
    return currentSortOrder==="asc"?result:-result;
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
        ${validImage(x.photoDataUrl)&&x.photoDataUrl?`<img class="item-image" src="${esc(x.photoDataUrl)}" alt="">`:`<div class="item-image placeholder">□</div>`}
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
function setSort(){
  currentSort=$("sortField").value;
  currentSortOrder=$("sortOrder").value;
  localStorage.setItem("inventory-sort",currentSort);
  localStorage.setItem("inventory-sort-order",currentSortOrder);
  render();
}
function resetForm(){
  $("itemForm").reset();$("itemId").value="";$("barcode").value="";$("quantity").value=1;$("formTitle").textContent="在庫を追加";
  $("deleteBtn").hidden=true;$("photoPreview").hidden=true;$("photoPreview").removeAttribute("src");currentPhoto=null;
  renderSuggestions();
}
function editItem(id){
  const x=allItems.find(i=>i.id===id);if(!x)return;resetForm();
  $("itemId").value=x.id;$("name").value=x.name;$("barcode").value=x.barcode||"";$("quantity").value=x.quantity;$("unit").value=x.unit||"";
  $("category").value=x.category||"";$("location").value=x.location||"";$("note").value=x.note||"";$("keywords").value=x.keywords||"";
  $("formTitle").textContent="在庫を編集";$("deleteBtn").hidden=false;currentPhoto=validImage(x.photoDataUrl)?x.photoDataUrl:null;
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
  c.getContext("2d").drawImage(img,0,0,c.width,c.height);img.close();const data=c.toDataURL("image/jpeg",.8);
  if(!validImage(data))throw new Error("画像が大きすぎます");return data;
}
function stopScanner(){
  if(scannerTimer)cancelAnimationFrame(scannerTimer);
  scannerTimer=null;
  scannerStream?.getTracks().forEach(track=>track.stop());
  scannerStream=null;
  $("scannerVideo").srcObject=null;
}
async function openScanner(){
  if(!navigator.mediaDevices?.getUserMedia){alert("この端末ではカメラを利用できません。バーコードを手入力してください。");return}
  if(!("BarcodeDetector" in window)){alert("このブラウザではカメラ読取りに対応していません。バーコードを手入力してください。");return}
  try{
    const wanted=["aztec","code_128","code_39","code_93","codabar","data_matrix","ean_13","ean_8","itf","pdf417","qr_code","upc_a","upc_e"];
    const supported=await BarcodeDetector.getSupportedFormats();
    const formats=wanted.filter(format=>supported.includes(format));
    if(!formats.length)throw new Error("対応形式がありません");
    barcodeDetector=new BarcodeDetector({formats});
    $("scannerMessage").textContent="カメラへのアクセスを許可し、バーコードまたはQRコードを枠内に入れてください。";
    $("scannerDialog").showModal();
    scannerStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});
    const video=$("scannerVideo");video.srcObject=scannerStream;await video.play();
    const scan=async()=>{
      if(!scannerStream||video.readyState<2){scannerTimer=requestAnimationFrame(scan);return}
      try{
        const codes=await barcodeDetector.detect(video);
        if(codes[0]?.rawValue){
          $("barcode").value=codes[0].rawValue;
          stopScanner();$("scannerDialog").close();showToast("コードを読み取りました");return;
        }
      }catch{}
      scannerTimer=requestAnimationFrame(scan);
    };
    scan();
  }catch(err){
    stopScanner();$("scannerDialog").close();
    alert("カメラを開始できませんでした。アクセス許可を確認するか、バーコードを手入力してください。");
  }
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
      ${validImage(x.photoDataUrl)&&x.photoDataUrl?`<img src="${esc(x.photoDataUrl)}" alt="">`:`<div class="trash-placeholder">□</div>`}
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
  const item={id:old?.id||crypto.randomUUID(),name:$("name").value.trim(),barcode:$("barcode").value.trim(),quantity:Number($("quantity").value),unit:$("unit").value.trim(),category:$("category").value.trim(),location:$("location").value.trim(),note:$("note").value.trim(),keywords:unique($("keywords").value.split(/[,、\n]/)).join("、"),photoDataUrl:$("removePhoto").checked?null:currentPhoto,createdAt:old?.createdAt||now,updatedAt:now};
  await tx("readwrite",s=>s.put(item));$("editor").close();await refresh();scheduleSync();
});
$("deleteBtn").addEventListener("click",async()=>{const id=$("itemId").value;if(id){await moveToTrash(id,true);$("editor").close()}});
$("addBtn").addEventListener("click",()=>{resetForm();$("editor").showModal()});
$("closeBtn").addEventListener("click",()=>$("editor").close());
$("scanBarcodeBtn").addEventListener("click",openScanner);
$("closeScannerBtn").addEventListener("click",()=>{stopScanner();$("scannerDialog").close()});
$("scannerDialog").addEventListener("close",stopScanner);
$("search").addEventListener("input",render);
$("clearSearch").addEventListener("click",()=>{$("search").value="";render()});
$("categoryFilter").addEventListener("change",render);
$("sortField").addEventListener("change",setSort);
$("sortOrder").addEventListener("change",setSort);
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
function validRestorePayload(payload){return payload?.app==="stock-pwa"&&Array.isArray(payload.items)&&payload.items.length<=MAX_ITEMS_PER_SYNC&&payload.items.every(validInventoryItem)}
async function downloadBackup(payload){
  const blob=new Blob([JSON.stringify(payload)],{type:"application/json"}),name=`在庫バックアップ_${new Date().toISOString().slice(0,10)}.json`,file=new File([blob],name,{type:"application/json"});
  if(navigator.share&&navigator.canShare?.({files:[file]}))await navigator.share({files:[file],title:"在庫バックアップ"});
  else{const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;a.click();URL.revokeObjectURL(a.href)}
}
function openBackupPassword(mode,data=null){
  pendingBackup={mode,data};$("backupPassword").value="";
  $("backupPasswordTitle").textContent=mode==="export"?"暗号化バックアップ":"暗号化バックアップを復元";
  $("backupPasswordNote").textContent=mode==="export"?"バックアップを暗号化するパスワードを設定します。忘れると復元できません。":"このバックアップを書き出したときのパスワードを入力してください。";
  $("backupPasswordDialog").showModal();$("backupPassword").focus();
}
async function importItems(items){
  if(!validRestorePayload({app:"stock-pwa",items}))throw new Error("形式または内容が正しくありません");
  if(!confirm("現在の在庫に追加・上書きしますか？"))return;
  await tx("readwrite",s=>items.forEach(i=>s.put(i)));await refresh();scheduleSync();alert(`${items.length}件を復元しました`);
}
$("backupBtn").addEventListener("click",()=>openBackupPassword("export"));
$("syncBtn").addEventListener("click",async()=>{
  if(!cloudSyncEnabled()){
    if(!confirm("この端末の在庫を、ログインで保護されたクラウドに同期します。続けますか？"))return;
    localStorage.setItem("inventory-cloud-sync","true");
  }
  await syncNow();
});
$("loginForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const password=$("syncPassword").value;
  try{
    const r=await fetch(`${SYNC_ORIGIN}/v1/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password})});
    if(!r.ok)throw new Error("パスワードが正しくありません");
    const data=await r.json();if(!data.token)throw new Error("ログイン情報を取得できませんでした");
    await deriveAndStoreVaultKey(password);localStorage.setItem("inventory-sync-token",data.token);$("loginDialog").close();await syncNow();
  }catch(err){alert(`ログインできませんでした：${err.message}`)}
});
$("closeLoginBtn").addEventListener("click",()=>$("loginDialog").close());
$("backupPasswordForm").addEventListener("submit",async e=>{
  e.preventDefault();const task=pendingBackup,password=$("backupPassword").value;
  try{
    if(task?.mode==="export"){
      const salt=crypto.getRandomValues(new Uint8Array(16)),key=await deriveAesKey(password,salt);
      const payload={app:"stock-pwa",version:"4.0",exportedAt:new Date().toISOString(),items:await getAll()};
      if(!validRestorePayload(payload))throw new Error("在庫データの形式が正しくありません");
      const encrypted=await encryptValue(payload,key,MAX_BACKUP_BYTES);
      await downloadBackup({app:"stock-pwa",version:"4.0",encrypted:true,kdf:{name:"PBKDF2",hash:"SHA-256",iterations:BACKUP_KDF_ITERATIONS,salt:bytesToBase64(salt)},...encrypted});
      showToast("暗号化バックアップを書き出しました");
    }else if(task?.mode==="restore"){
      const {data}=task,salt=base64ToBytes(data.kdf.salt),key=await deriveAesKey(password,salt,data.kdf.iterations);
      const payload=await decryptValue(data,key);await importItems(payload.items);
    }
    $("backupPasswordDialog").close();pendingBackup=null;
  }catch(err){alert("処理できませんでした："+(err.message||"パスワードを確認してください"))}
});
$("closeBackupPasswordBtn").addEventListener("click",()=>{$("backupPasswordDialog").close();pendingBackup=null});
$("restoreInput").addEventListener("change",async e=>{
  const f=e.target.files[0];if(!f)return;
  try{
    if(f.size>MAX_BACKUP_BYTES*2)throw new Error("バックアップファイルが大きすぎます");
    const data=JSON.parse(await f.text());
    if(data?.app!=="stock-pwa")throw new Error("形式が違います");
    if(data.encrypted===true){
      if(!data.kdf||data.kdf.name!=="PBKDF2"||data.kdf.hash!=="SHA-256"||!Number.isInteger(data.kdf.iterations)||data.kdf.iterations<100000||data.kdf.iterations>1000000||typeof data.kdf.salt!=="string"||typeof data.iv!=="string"||typeof data.ciphertext!=="string")throw new Error("暗号化バックアップの形式が違います");
      openBackupPassword("restore",data);
    }else{
      // 以前の平文バックアップは、形式を厳格に検査したうえで一度だけ復元を許可する。
      await importItems(data.items);
    }
  }catch(err){alert("復元できませんでした："+err.message)}finally{e.target.value=""}
});
async function showStorage(){
  if(!navigator.storage?.estimate){$("storageInfo").textContent="在庫データはこのiPhone内に保存されています。大切なデータは定期的にバックアップしてください。";return}
  const e=await navigator.storage.estimate(),used=(e.usage/1048576).toFixed(1);
  $("storageInfo").textContent=`在庫データはこのiPhone内に保存中（使用量 約${used}MB）。SafariのWebサイトデータを削除する前に、バックアップを書き出してください。`;
}

["name","category","location","keywords"].forEach(id=>$(id).addEventListener("input",renderSuggestions));

(async()=>{db=await openDB();vaultKey=await settingGet("vaultKey");setView(currentView);$("sortField").value=currentSort;$("sortOrder").value=currentSortOrder;await refresh();updateSyncStatus();await showStorage();if("serviceWorker"in navigator)navigator.serviceWorker.register("./sw.js").catch(console.error);window.addEventListener("online",()=>scheduleSync());scheduleSync()})().catch(err=>alert("起動エラー："+err.message));
