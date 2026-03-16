// ============ FIREBASE ============
const firebaseConfig={
  apiKey:"AIzaSyB64IB1fB8rCMKWxzsFTzXl5ni0eZf48TM",
  authDomain:"warehouse-space-dashboard.firebaseapp.com",
  databaseURL:"https://warehouse-space-dashboard-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:"warehouse-space-dashboard",
  storageBucket:"warehouse-space-dashboard.firebasestorage.app",
  messagingSenderId:"772239262006",
  appId:"1:772239262006:web:d7278e6ccd647dd919b397"
};
firebase.initializeApp(firebaseConfig);
const fbDB=firebase.database();

// ============ GLOBALS ============
let RAW=[],FD=[],charts={},tblPage=0,tblSort={key:'dt',asc:false},initialized=false;
let CUR='EUR',VMODE='val',QF=0;
let TRACKED_ETA={},TRACKED_STS={},TRACKED_TS={};
let PLANNER_WEEKS=[],PLANNER_MONTHS=[],KANBAN_COLS=[],KANBAN_ITEMS=[];
let DATE_MODE='invoice'; // 'invoice' = Invoice Date, 'delivered' = Delivery/ETA Date
// Robust number parser — handles € symbols, commas, European format (1.200,50), spaces
function parseVal(v){
  if(v===null||v===undefined||v==='')return 0;
  if(typeof v==='number')return v;
  let s=String(v).trim();
  if(s.startsWith('='))return NaN; // formula
  // Strip currency symbols and common text
  s=s.replace(/[€$£¥₹]|EUR|USD|GBP|INR/gi,'').trim();
  // Strip spaces (including non-breaking)
  s=s.replace(/[\s\u00A0]/g,'');
  // Count separators
  const dots=(s.match(/\./g)||[]).length;
  const commas=(s.match(/,/g)||[]).length;
  const lastComma=s.lastIndexOf(','),lastDot=s.lastIndexOf('.');
  // Multiple dots = European thousands (e.g. "1.234.567") → strip dots
  if(dots>1&&commas===0){s=s.replace(/\./g,'')}
  // Multiple commas = US/Indian thousands (e.g. "1,234,567") → strip commas
  else if(commas>1&&dots===0){s=s.replace(/,/g,'')}
  // Both dots AND commas present: last separator is decimal
  else if(dots>0&&commas>0&&lastComma>lastDot){s=s.replace(/\./g,'').replace(',','.')} // European: 1.234,56
  else if(dots>0&&commas>0&&lastDot>lastComma){s=s.replace(/,/g,'')} // US: 1,234.56
  // Only commas, no dots
  else if(commas===1&&dots===0){
    const afterComma=s.substring(lastComma+1);
    if(afterComma.length<=2)s=s.replace(',','.'); // decimal comma: 12,50
    else s=s.replace(/,/g,''); // thousands: 12,334
  }
  // Only dots, no commas — check if it's a thousands separator
  else if(dots===1&&commas===0){
    const afterDot=s.substring(lastDot+1);
    if(afterDot.length===3&&s.length>4){
      // "12.334" → 3 digits after dot AND more than 4 chars total → European thousands separator
      s=s.replace('.','');
    }
    // else: normal decimal like "12.34" or "0.5" — keep as-is
  }
  const n=parseFloat(s);
  return isNaN(n)?0:n;
}
const PG=50,PARCELS_API_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiIxN2Q4ODIyMC0wOGY5LTExZjEtOTZjNS05MTAxZWQ3MmMxODAiLCJzdWJJZCI6IjY5OGY1MTQ4MTg3ZmYwM2JiODRiNmM0YiIsImlhdCI6MTc3MTAwMDEzNn0.YqK3VSNqwySh-w1or3_nIE_-TvQvaq0HjXUJ2ir2G1Q',TRACK_COOLDOWN=10800000;
// Parcels App API — universal tracking for parcels, air cargo, containers, vessels
const PARCELS_API='https://parcelsapp.com/api/v3/shipments/tracking';
const MNAMES=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CSYM={EUR:'\u20AC',USD:'$'},CRATE={EUR:1,USD:1.08};
const COLORS=['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#ec4899','#14b8a6','#a855f7','#eab308','#6366f1'];

// Carrier code mapping (legacy, kept for detectCarrier fallback)
const CARRIER_MAP={
  'ups':100002,'UPS':100002,
  'fedex':100003,'Fedex':100003,'FedEx':100003,
  'dhl':100001,'DHL':100001,
  'tnt':100004,'TNT':100004,
  'dpd':100007,'DPD':100007,
  'aramex':100006,'Aramex':100006,'aramax':100006,'Aramax':100006,
  'dsv':100046,'DSV':100046,
  'royalmail':100051,'Royalmail':100051,
  'ferrari':190272,'Ferrari':190272,
  'mainfreight':100592,'Mainfreight':100592
};
// AWB detection (Parcels API handles AWBs natively)
// AWB (Air Waybill) detection — format: XXX-XXXXXXXX or XXXXXXXXXXX (11 digits)
// Prefix is 3-digit IATA airline code (e.g. 157=Qatar, 176=Emirates, 235=Turkish, 057=Air France, 006=Delta)
function isAWB(num){
  const n=(num||'').replace(/\s+/g,'').trim();
  return/^\d{3}-\d{8}$/.test(n)||/^\d{11}$/.test(n);
}

// ============ CONTAINER / SEA CARRIER DETECTION ============
// Container number format: 4 letters + 7 digits (ISO 6346), e.g. MAEU1234567
// Container field format from data: "MSK - CAAU4896044" or "HPL - HLBU1751926" or just "CAAU4896044"
const CONTAINER_CARRIERS={
  // Maersk container prefixes
  'MAEU':{name:'Maersk',code:'MSK'},'MSKU':{name:'Maersk',code:'MSK'},'MRKU':{name:'Maersk',code:'MSK'},
  'SEAU':{name:'Maersk',code:'MSK'},'MCPU':{name:'Maersk',code:'MSK'},
  // Hapag-Lloyd
  'HLBU':{name:'Hapag-Lloyd',code:'HPL'},'HLXU':{name:'Hapag-Lloyd',code:'HPL'},'HAMU':{name:'Hapag-Lloyd',code:'HPL'},
  'FANU':{name:'Hapag-Lloyd',code:'HPL'},'CAAU':{name:'Hapag-Lloyd',code:'HPL'},'FDCU':{name:'Hapag-Lloyd',code:'HPL'},
  'SEGU':{name:'Hapag-Lloyd',code:'HPL'},'TGHU':{name:'Hapag-Lloyd',code:'HPL'},'TLLU':{name:'Hapag-Lloyd',code:'HPL'},
  'UACU':{name:'Hapag-Lloyd',code:'HPL'},
  // CMA CGM
  'CMAU':{name:'CMA CGM',code:'CMA'},'APZU':{name:'CMA CGM',code:'CMA'},'CGMU':{name:'CMA CGM',code:'CMA'},
  // COSCO
  'COSU':{name:'COSCO',code:'COSCO'},'CSNU':{name:'COSCO',code:'COSCO'},'CCLU':{name:'COSCO',code:'COSCO'},
  'OOLU':{name:'COSCO',code:'COSCO'},'CBHU':{name:'COSCO',code:'COSCO'},'CSLU':{name:'COSCO',code:'COSCO'},
  // MSC
  'MSCU':{name:'MSC',code:'MSC'},'MEDU':{name:'MSC',code:'MSC'},'MSDU':{name:'MSC',code:'MSC'},
  // HMM
  'HDMU':{name:'HMM',code:'HMM'},'HMMU':{name:'HMM',code:'HMM'},'KOCU':{name:'HMM',code:'HMM'},
  // ONE (Ocean Network Express)
  'ONEU':{name:'ONE',code:'ONE'},'NYKU':{name:'ONE',code:'ONE'},'MOFU':{name:'ONE',code:'ONE'},
  'KKFU':{name:'ONE',code:'ONE'},
  // Evergreen
  'EISU':{name:'Evergreen',code:'EMC'},'EMCU':{name:'Evergreen',code:'EMC'},'EGHU':{name:'Evergreen',code:'EMC'},
  'EGSU':{name:'Evergreen',code:'EMC'},'BEAU':{name:'Evergreen',code:'EMC'},
  // Yang Ming
  'YMLU':{name:'Yang Ming',code:'YML'},'YMMU':{name:'Yang Ming',code:'YML'},
  // DSV
  'DSVU':{name:'DSV',code:'DSV'},
  // Generic / common leased containers
  'TCLU':{name:'Triton',code:'TRITON'},'TEMU':{name:'Triton',code:'TRITON'},
  'TRLU':{name:'Triton',code:'TRITON'},'GESU':{name:'Beacon',code:'BEACON'},
  'FCIU':{name:'Florens',code:'FLORENS'},'FSCU':{name:'Florens',code:'FLORENS'},
  'CAIU':{name:'CAI',code:'CAI'},'TRIU':{name:'Triton',code:'TRITON'}
};

// Carrier tracking URLs — each returns the direct tracking URL for a container number
const CARRIER_TRACK_URLS={
  'MSK':  (n)=>'https://www.maersk.com/tracking/'+n,
  'HPL':  (n)=>'https://www.hapag-lloyd.com/en/online-business/track/track-by-container-solution.html?container='+n,
  'CMA':  (n)=>'https://www.cma-cgm.com/ebusiness/tracking/search?SearchBy=Container&Reference='+n,
  'COSCO':(n)=>'https://elines.coscoshipping.com/ebusiness/cargoTracking?trackingType=CONTAINER&number='+n,
  'MSC':  (n)=>'https://www.msc.com/en/track-a-shipment?agencyPath=msc&trackingNumber='+n,
  'HMM':  (n)=>'https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do?cntrNo='+n,
  'ONE':  (n)=>'https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?redir=Y&cntrNo='+n,
  'EMC':  (n)=>'https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do?cntrNo='+n,
  'YML':  (n)=>'https://www.yangming.com/e-service/schedule/CntrTracking.aspx?cntr='+n,
  'DSV':  (n)=>'https://www.dsv.com/en/support/track-and-trace?reference='+n
};

// Detect container carrier from container number or container field value
// Input examples: "CAAU4896044", "MSK - CAAU4896044", "HPL - HLBU1751926"
function getContainerCarrier(contVal){
  if(!contVal)return null;
  const v=contVal.trim();
  // Check if it has a carrier prefix like "MSK - " or "CMA-"
  const prefixMatch=v.match(/^([A-Z]+)\s*[-–]\s*/i);
  if(prefixMatch){
    const pfx=prefixMatch[1].toUpperCase();
    // Direct carrier code match
    if(CARRIER_TRACK_URLS[pfx])return{name:pfx,code:pfx};
    // Check aliases
    const aliases={'ONELINE':'ONE','COSCO':'COSCO'};
    if(aliases[pfx])return{name:pfx,code:aliases[pfx]};
  }
  // Extract container number (4 letters + digits)
  const contMatch=v.match(/([A-Z]{4})\d{6,7}/i);
  if(contMatch){
    const prefix=contMatch[1].toUpperCase();
    if(CONTAINER_CARRIERS[prefix])return CONTAINER_CARRIERS[prefix];
  }
  return null;
}

// Extract just the container number from field like "MSK - CAAU4896044" or "HPL-UACU 5235094"
function extractContainerNum(contVal){
  if(!contVal)return null;
  // Remove spaces within container codes (e.g. "UACU 5235094" → "UACU5235094")
  const cleaned=contVal.replace(/([A-Z]{4})\s+(\d)/gi,'$1$2');
  const m=cleaned.match(/([A-Z]{4}\d{6,7})/i);
  return m?m[1].toUpperCase():contVal.replace(/[^A-Z0-9]/gi,'').toUpperCase();
}

// Check if a tracking number is a container number (4 letters + 7 digits)
function isContainerNum(num){
  const n=(num||'').replace(/[-\s]/g,'').trim();
  return/^[A-Z]{4}\d{6,7}$/i.test(n);
}

// Get the tracking URL for a container (uses carrier detection)
function getContainerTrackUrl(contVal){
  const carrier=getContainerCarrier(contVal);
  const contNum=extractContainerNum(contVal);
  if(carrier&&carrier.code&&CARRIER_TRACK_URLS[carrier.code]){
    return{url:CARRIER_TRACK_URLS[carrier.code](contNum),carrier:carrier,contNum:contNum};
  }
  // Fallback to generic tracking sites
  return{url:'https://www.track-trace.com/container?number='+contNum,carrier:{name:'Unknown',code:'GENERIC'},contNum:contNum};
}

// Smart carrier detection: checks mode field THEN tracking number patterns
function detectCarrier(num,mode){
  // 1. Direct mode match
  if(mode&&CARRIER_MAP[mode])return CARRIER_MAP[mode];
  // 2. Partial mode match (e.g. "DHL/Sea" contains "dhl")
  if(mode){const ml=mode.toLowerCase();
    if(ml.includes('ups'))return 100002;if(ml.includes('fedex')||ml.includes('fed'))return 100003;
    if(ml.includes('dhl'))return 100001;if(ml.includes('tnt'))return 100004;
    if(ml.includes('dpd'))return 100007;if(ml.includes('aramex')||ml.includes('aramax'))return 100006;
    if(ml.includes('dsv'))return 100046;if(ml.includes('mainfreight'))return 100592;
  }
  // 3. Auto-detect from tracking number patterns (strip spaces)
  const n=(num||'').replace(/\s+/g,'').trim();
  if(/^1Z/i.test(n))return 100002; // UPS: starts with 1Z
  if(/^\d{12,22}$/.test(n))return 100003; // FedEx: 12-22 pure digits
  if(/^\d{10}$/.test(n))return 100001; // DHL Express: exactly 10 digits
  if(/^JD\d{18}/i.test(n))return 100001; // DHL eCommerce
  if(/^[A-Z]{2}\d{9}[A-Z]{2}$/i.test(n))return 100051; // Royal Mail format
  // AWB air cargo — return null so auto_detection handles it in trackOne
  if(isAWB(n))return null;
  return null;
}

// ============ CURRENCY & TOGGLES ============
function setCurrency(c){CUR=c;renderAll()}
function fc(n){return CSYM[CUR]+fv(n*CRATE[CUR])}
function fcFull(n){return CSYM[CUR]+(n*CRATE[CUR]).toLocaleString('en-US',{maximumFractionDigits:0})}
function fv(n){if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return n.toFixed(0)}
function setVMode(m){VMODE=m;document.querySelectorAll('.vq-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode===m));renderAll()}
function setQF(months){QF=months;updQF();document.getElementById('fMonth').value='';af()}
function updQF(){document.querySelectorAll('.qf-btn').forEach((b,i)=>{const v=[1,3,6,12,0];b.classList.toggle('active',v[i]===QF)})}
function setDateMode(m){DATE_MODE=m;document.querySelectorAll('.dm-btn').forEach(b=>b.classList.toggle('active',b.dataset.dm===m));renderAll()}
function getRecDate(r){if(DATE_MODE==='delivered'){return r.aeta||r.eta||r.dt}return r.dt}

// ============ HELPERS ============
function isTrans(r){return(r.fsts||'').toLowerCase().includes('transit')}
function isApiDelivered(r){const ct=cleanTrk(r.trk);const sts=ct?TRACKED_STS[ct]:null;return sts&&sts.toLowerCase().includes('deliver')}
function isAir(r){const m=(r.mode||'').toLowerCase();return m==='air'||['fedex','dhl','ups','tnt','dpd','aramex','aramax','hawb','royalmail','dsv','ferrari','sinotech','china southern','international express'].some(c=>m.includes(c))}
function isSea(r){const m=(r.mode||'').toLowerCase();return m==='sea'||m.includes('sea')||m==='mainfreight'}
function daysUntil(eta){return Math.ceil((new Date(eta)-new Date())/(86400000))}
function getTimePeriod(dt,tg){
  if(!dt||dt.length<7)return null;const ym=dt.substring(0,7);
  if(tg==='month')return ym;
  const[y,m]=ym.split('-').map(Number);
  if(tg==='quarter')return y+'Q'+Math.ceil(m/3);
  if(tg==='year')return String(y);return ym;
}
function stsBadge(s){
  if(!s)return'<span class="sb sb-pak">Unknown</span>';const l=s.toLowerCase();
  if(l.includes('received'))return'<span class="sb sb-rcv">'+s+'</span>';
  if(l.includes('transit'))return'<span class="sb sb-trn">'+s+'</span>';
  if(l.includes('delivered')||l.includes('ams'))return'<span class="sb sb-nam">'+s+'</span>';
  return'<span class="sb sb-pak">'+s+'</span>';
}
function catBadgeCls(cat){if(!cat)return'kb-def';const c=cat.toUpperCase();if(c==='JP')return'kb-jp';if(c==='LSP')return'kb-lsp';if(c.includes('SAMPLE'))return'kb-smp';if(c==='NGP')return'kb-ngp';return'kb-def'}

// ============ TRACKED ETA MANAGEMENT (Firebase synced) ============
function timeAgo(ts){if(!ts)return null;const d=Date.now()-ts;if(d<60000)return'just now';if(d<3600000)return Math.floor(d/60000)+'m ago';if(d<86400000)return Math.floor(d/3600000)+'h ago';return Math.floor(d/86400000)+'d ago'}
function fmtTrackTime(ts){if(!ts)return'';const d=new Date(ts);return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'})+' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}
function loadTrackedETAs(){
  // 1. Load from localStorage first (fast, offline fallback)
  try{const d=JSON.parse(localStorage.getItem('TRACKED_ETAS')||'{}');const now=Date.now();
    Object.keys(d).forEach(k=>{if(now-d[k].ts<86400000){if(d[k].eta)TRACKED_ETA[k]=d[k].eta;if(d[k].sts)TRACKED_STS[k]=d[k].sts;TRACKED_TS[k]=d[k].ts}});
  }catch(e){}
  // 2. Load from Firebase (shared across all users) + listen for live updates
  try{
    fbDB.ref('tracking').on('value',(snap)=>{
      const fbData=snap.val();if(!fbData)return;
      const now=Date.now();let updated=false;
      Object.keys(fbData).forEach(k=>{
        const entry=fbData[k];if(!entry||!entry.ts)return;
        if(now-entry.ts>86400000*7)return; // ignore entries older than 7 days
        // Only update if Firebase has newer data than what we have locally
        if(!TRACKED_TS[k]||entry.ts>TRACKED_TS[k]){
          if(entry.eta)TRACKED_ETA[k]=entry.eta;
          if(entry.sts)TRACKED_STS[k]=entry.sts;
          TRACKED_TS[k]=entry.ts;
          updated=true;
        }
      });
      // Sync Firebase data to localStorage for offline access
      if(updated){
        try{
          const ls=JSON.parse(localStorage.getItem('TRACKED_ETAS')||'{}');
          Object.keys(fbData).forEach(k=>{
            const entry=fbData[k];if(!entry||!entry.ts)return;
            if(!ls[k]||entry.ts>(ls[k].ts||0)){
              ls[k]={eta:entry.eta||null,sts:entry.sts||null,ts:entry.ts};
            }
          });
          localStorage.setItem('TRACKED_ETAS',JSON.stringify(ls));
        }catch(e){}
        // Sync TRACK_CACHE from Firebase too
        if(fbData){
          try{
            const localCache=JSON.parse(localStorage.getItem('TRACK_CACHE')||'{}');
            Object.keys(fbData).forEach(k=>{
              const entry=fbData[k];
              if(entry&&entry.trackData&&entry.ts&&(!localCache[k]||entry.ts>(localCache[k].ts||0))){
                localCache[k]={ts:entry.ts,data:entry.trackData};
              }
            });
            localStorage.setItem('TRACK_CACHE',JSON.stringify(localCache));
          }catch(e){}
        }
        // Re-extract ETAs with latest logic (e.g. delivered_by field) and push to Firebase
        reExtractCachedETAs();
        // Re-render if dashboard already loaded to show fresh tracking data
        if(initialized)renderAll();
      }
    });
  }catch(e){console.warn('Firebase tracking listener error:',e)}
  // 3. Listen for lastUpdated timestamp
  try{
    fbDB.ref('meta/lastUpdated').on('value',(snap)=>{
      const ts=snap.val();
      const el=document.getElementById('lastUpdated');
      if(el&&ts){
        const d=new Date(ts);
        const now=new Date();
        const diffMs=now-d;
        const diffMin=Math.floor(diffMs/60000);
        const diffHr=Math.floor(diffMs/3600000);
        const diffDay=Math.floor(diffMs/86400000);
        let ago='';
        if(diffMin<1)ago='just now';
        else if(diffMin<60)ago=diffMin+'m ago';
        else if(diffHr<24)ago=diffHr+'h ago';
        else ago=diffDay+'d ago';
        const dateStr=d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
        const timeStr=d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
        el.innerHTML='\u{1F4C5} Last updated: <strong>'+dateStr+' '+timeStr+'</strong> <span style="opacity:.6">('+ago+')</span>';
      }
    });
  }catch(e){}
}
function reExtractCachedETAs(){try{const cache=JSON.parse(localStorage.getItem('TRACK_CACHE')||'{}');const updatedKeys=[];Object.keys(cache).forEach(k=>{const entry=cache[k];if(!entry||!entry.data)return;const newEta=extractETAFromTracking(entry.data);const newSts=extractStatusFromTracking(entry.data);let changed=false;if(newEta&&TRACKED_ETA[k]!==newEta){TRACKED_ETA[k]=newEta;TRACKED_TS[k]=Date.now();changed=true}if(newSts&&TRACKED_STS[k]!==newSts){TRACKED_STS[k]=newSts;changed=true}if(changed)updatedKeys.push(k)});if(updatedKeys.length>0){try{const d=JSON.parse(localStorage.getItem('TRACKED_ETAS')||'{}');updatedKeys.forEach(k=>{d[k]={eta:TRACKED_ETA[k]||null,sts:TRACKED_STS[k]||null,ts:TRACKED_TS[k]||Date.now()};try{const fbKey=k.replace(/[.#$/\[\]]/g,'_');fbDB.ref('tracking/'+fbKey).update({eta:TRACKED_ETA[k]||null,sts:TRACKED_STS[k]||null,ts:TRACKED_TS[k]||Date.now()})}catch(e){}});localStorage.setItem('TRACKED_ETAS',JSON.stringify(d))}catch(e){}};}catch(e){console.warn('reExtractCachedETAs error:',e)}}
// ============ COLLAPSIBLE SECTIONS ============
function toggleCollapse(hdr){
  hdr.classList.toggle('open');
  const body=hdr.nextElementSibling;
  if(body&&body.classList.contains('coll-body')){body.classList.toggle('open')}
}
function makeCollapsible(id,title,content,summaryHtml,startOpen){
  return `<div class="coll-sec"><div class="coll-hdr${startOpen?' open':''}" onclick="toggleCollapse(this)" id="coll_${id}">${title}${summaryHtml?'<div class="coll-summary">'+summaryHtml+'</div>':''}<span class="coll-chev">&#x25BC;</span></div><div class="coll-body${startOpen?' open':''}">${content}</div></div>`;
}
function saveTrackedInfo(trk,eta,sts){
  trk=cleanTrk(trk);if(!trk)return;
  if(eta)TRACKED_ETA[trk]=eta;if(sts)TRACKED_STS[trk]=sts;TRACKED_TS[trk]=Date.now();
  // Save to localStorage
  try{const d=JSON.parse(localStorage.getItem('TRACKED_ETAS')||'{}');
    d[trk]={eta:eta||d[trk]?.eta||null,sts:sts||d[trk]?.sts||null,ts:Date.now()};
    localStorage.setItem('TRACKED_ETAS',JSON.stringify(d));
  }catch(e){}
  // Save to Firebase (shared with all users)
  try{
    const fbKey=trk.replace(/[.#$/\[\]]/g,'_');
    const fbEntry={eta:eta||null,sts:sts||null,ts:Date.now()};
    fbDB.ref('tracking/'+fbKey).update(fbEntry);
  }catch(e){console.warn('Firebase tracking save error:',e)}
}
// ============ DELIVERY CONFIRMATION CONTROL ============
// Two-step flow: 1) API shows delivered → 2) User manually confirms receipt
// This updates BOTH tracking status AND the actual shipment record in Firebase

function confirmDelivery(trk,cont,inv){
  // Show confirmation dialog
  const contNum=cont?extractContainerNum(cont):null;
  const label=inv||(trk||contNum||'Shipment');
  const today=new Date().toISOString().substring(0,10);

  // Build modal
  let existing=document.getElementById('deliveryConfirmModal');
  if(existing)existing.remove();

  const overlay=document.createElement('div');
  overlay.id='deliveryConfirmModal';
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:10000;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML=`<div style="background:linear-gradient(180deg,#1e293b,#1a2332);border:1px solid #10b981;border-radius:16px;padding:28px;max-width:480px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.5)">
    <h2 style="font-size:18px;color:#10b981;margin-bottom:6px">\u2705 Confirm Delivery Receipt</h2>
    <p style="font-size:12px;color:#94a3b8;margin-bottom:16px">The courier API shows this shipment as <strong style="color:#10b981">Delivered</strong>. Please confirm you have received it.</p>
    <div style="background:rgba(15,23,42,.6);border:1px solid #334155;border-radius:10px;padding:14px;margin-bottom:16px;font-size:12px">
      <div style="margin-bottom:6px"><span style="color:#94a3b8">Shipment:</span> <strong style="color:#f1f5f9">${label}</strong></div>
      ${trk?'<div style="margin-bottom:6px"><span style="color:#94a3b8">Tracking:</span> <span style="color:#22d3ee">'+trk+'</span></div>':''}
      ${contNum?'<div style="margin-bottom:6px"><span style="color:#94a3b8">Container:</span> <span style="color:#f472b6">'+contNum+'</span></div>':''}
    </div>
    <div style="margin-bottom:16px">
      <label style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;font-weight:600;display:block;margin-bottom:4px">Delivery Received Date</label>
      <input type="date" id="confirmDelivDate" value="${today}" style="background:#0f172a;border:1px solid #475569;color:#f1f5f9;padding:8px 12px;border-radius:6px;font-size:13px;width:100%;outline:none">
    </div>
    <div style="margin-bottom:16px">
      <label style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;font-weight:600;display:block;margin-bottom:4px">Update Status To</label>
      <select id="confirmDelivStatus" style="background:#0f172a;border:1px solid #475569;color:#f1f5f9;padding:8px 12px;border-radius:6px;font-size:13px;width:100%;outline:none;cursor:pointer">
        <option value="Received in System">Received in System</option>
        <option value="Delivered">Delivered</option>
        <option value="Delivered but not in AMS">Delivered but not in AMS</option>
      </select>
    </div>
    <div style="margin-bottom:16px">
      <label style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;font-weight:600;display:block;margin-bottom:4px">Remark (Optional)</label>
      <input type="text" id="confirmDelivRemark" placeholder="e.g. Received by warehouse, GRN pending..." style="background:#0f172a;border:1px solid #475569;color:#f1f5f9;padding:8px 12px;border-radius:6px;font-size:12px;width:100%;outline:none">
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;padding-top:12px;border-top:1px solid #334155">
      <button onclick="document.getElementById('deliveryConfirmModal').remove()" style="padding:8px 18px;border-radius:7px;border:1px solid #475569;background:transparent;color:#94a3b8;font-size:12px;font-weight:600;cursor:pointer">\u2715 Cancel</button>
      <button onclick="executeDeliveryConfirm('${(trk||'').replace(/'/g,"\\'")}','${(cont||'').replace(/'/g,"\\'")}','${(inv||'').replace(/'/g,"\\'")}')" style="padding:8px 22px;border-radius:7px;border:none;background:linear-gradient(135deg,#10b981,#059669);color:#fff;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(16,185,129,.3)">\u2705 Confirm Delivered</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
}

function executeDeliveryConfirm(trk,cont,inv){
  const dateEl=document.getElementById('confirmDelivDate');
  const stsEl=document.getElementById('confirmDelivStatus');
  const rmkEl=document.getElementById('confirmDelivRemark');
  const delivDate=dateEl?dateEl.value:'';
  const newFsts=stsEl?stsEl.value:'Received in System';
  const rmk=rmkEl?rmkEl.value.trim():'';
  const contNum=cont?extractContainerNum(cont):null;
  trk=(trk||'').replace(/\s+/g,'').trim();

  // 1. Update tracking status in Firebase tracking node
  if(trk){
    saveTrackedInfo(trk,delivDate||new Date().toISOString().substring(0,10),'Delivered');
  }
  if(contNum&&contNum!==trk){
    saveTrackedInfo(contNum,delivDate||new Date().toISOString().substring(0,10),'Delivered');
  }

  // 2. Update the actual shipment record(s) in Firebase — change fsts, aeta
  let updated=0;
  RAW.forEach((r,idx)=>{
    const matchByInv=inv&&r.inv&&r.inv===inv;
    const matchByTrk=trk&&r.trk&&cleanTrk(r.trk)===cleanTrk(trk);
    const matchByCont=contNum&&r.cont&&extractContainerNum(r.cont)===contNum;
    if(matchByInv||matchByTrk||matchByCont){
      r.fsts=newFsts;
      if(delivDate)r.aeta=delivDate;
      if(rmk)r.rmk=(r.rmk?r.rmk+' | ':'')+rmk;
      r.delivConfirmed=new Date().toISOString();
      updated++;
      // Save individual record to Firebase
      try{fbDB.ref('shipments/'+idx).update({fsts:r.fsts,aeta:r.aeta||null,rmk:r.rmk||null,delivConfirmed:r.delivConfirmed})}catch(e){console.warn('FB update error:',e)}
    }
  });

  // Close modal
  const modal=document.getElementById('deliveryConfirmModal');
  if(modal)modal.remove();

  // Re-render
  renderAll();

  // Toast
  const toast=document.createElement('div');
  toast.innerHTML='\u2705 Delivery Confirmed!<br><span style="font-size:11px">'+updated+' record(s) updated to "'+newFsts+'"'+(delivDate?' on '+delivDate:'')+'</span>';
  toast.style.cssText='position:fixed;bottom:24px;right:24px;background:linear-gradient(135deg,#10b981,#059669);color:#fff;padding:16px 24px;border-radius:12px;font-weight:700;font-size:14px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.3);line-height:1.5';
  document.body.appendChild(toast);
  setTimeout(()=>toast.remove(),4000);
}
function saveTrackCacheToFirebase(trk,trackData){
  trk=cleanTrk(trk);if(!trk)return;
  try{
    const fbKey=trk.replace(/[.#$/\[\]]/g,'_');
    fbDB.ref('tracking/'+fbKey).update({trackData:trackData,ts:Date.now()});
  }catch(e){console.warn('Firebase track cache save error:',e)}
}
function extractETAFromTracking(info){
  try{
    // === PARCELS APP API FORMAT ===
    // Parcels format: {trackingId, status, states:[], attributes:[], origin, destination}
    if(info.states||info.trackingId){
      // DEBUG: Log key fields to help diagnose ETA extraction
      console.log('extractETA DEBUG: trackingId=',info.trackingId,'status=',info.status,
        'delivered_by=',info.delivered_by,'keys=',Object.keys(info).join(','),
        'attributes=',JSON.stringify((info.attributes||[]).slice(0,10)),
        'states[0]=',info.states&&info.states[0]?JSON.stringify(info.states[0]):'none');

      // 0. Check delivered_by / eta fields at multiple locations
      const delivBy=info.delivered_by||info.deliveredBy||info.eta||info.ETA||info.estimatedDelivery||info.estimated_delivery||(info.info&&(info.info.delivered_by||info.info.eta))||(info.extra&&(info.extra.delivered_by||info.extra.eta));
      if(delivBy){
        const db=new Date(delivBy);
        if(!isNaN(db)&&db.getFullYear()>2020){console.log('extractETA: found delivered_by/eta=',delivBy,'→',db.toISOString().substring(0,10));return db.toISOString().substring(0,10)}
        // Maybe it's just a date string like "2026-02-25"
        const dbm=(delivBy+'').match(/(\d{4}-\d{2}-\d{2})/);
        if(dbm){console.log('extractETA: parsed delivered_by/eta=',dbm[1]);return dbm[1]}
      }
      // 0b. Check attributes for estimated/expected delivery — broader matching
      if(info.attributes){
        for(const attr of info.attributes){
          const lbl=(attr.l||attr.label||attr.name||'').toLowerCase();
          const val=attr.val||attr.value||'';
          if(lbl.includes('deliver')||lbl.includes('eta')||lbl.includes('estimat')||lbl.includes('expect')||lbl.includes('arrival')){
            const dateMatch=(val).match(/(\d{4}-\d{2}-\d{2})/);
            if(dateMatch){console.log('extractETA: found attr',lbl,'=',dateMatch[1]);return dateMatch[1]}
            // Try "25 February 2026" or "Feb 25, 2026" style
            const d=new Date(val);if(!isNaN(d)&&d.getFullYear()>2020){console.log('extractETA: parsed attr',lbl,'=',d.toISOString().substring(0,10));return d.toISOString().substring(0,10)}
          }
        }
      }
      // 0c. Deep scan: look for any key containing "deliver" or "eta" in the entire info object
      const infoStr=JSON.stringify(info);
      const deepMatch=infoStr.match(/"(?:delivered_by|deliveredBy|estimatedDelivery|expected_delivery|eta_date|delivery_date|estimated_arrival|arrivalDate|arrival_date|expectedArrival|expected_arrival|deliveryDate|lastMileEstimate|promisedDate|scheduledDelivery|scheduledArrival)"\s*:\s*"([^"]+)"/i);
      if(deepMatch){
        const dd=new Date(deepMatch[1]);
        if(!isNaN(dd)&&dd.getFullYear()>2020){console.log('extractETA: deep scan found',deepMatch[0]);return dd.toISOString().substring(0,10)}
        // Try ISO date in the value
        const ddm=(deepMatch[1]).match(/(\d{4}-\d{2}-\d{2})/);
        if(ddm){console.log('extractETA: deep scan ISO=',ddm[1]);return ddm[1]}
      }
      // 0c2. Broader scan: look for ANY field with "eta" or "arrival" in key name that has a date value
      const broadMatch=infoStr.match(/"[^"]*(?:eta|ETA|arrival|deliver)[^"]*"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/i);
      if(broadMatch){
        const bm=broadMatch[1].substring(0,10);
        const bd=new Date(bm);
        if(!isNaN(bd)&&bd.getFullYear()>2020){console.log('extractETA: broad scan found',broadMatch[0]);return bm}
      }
      // 0d. Scan event descriptions for dates embedded in text (e.g. "ETA: 25 Feb 2026")
      if(info.states){
        for(const st of info.states){
          const desc=(st.status||'');
          const descL=desc.toLowerCase();
          if(descL.includes('depart')||descL.includes('loaded')||descL.includes('gate out'))continue;
          // Look for dates within the text of arrival/eta events
          if(descL.includes('estimat')||descL.includes('eta')||descL.includes('expect')||descL.includes('arrival')){
            // Try to find embedded date in the status text itself
            const embeddedDate=desc.match(/(\d{1,2}[\s\-\/](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\-\/]\d{4})/i);
            if(embeddedDate){
              const ed=new Date(embeddedDate[1]);
              if(!isNaN(ed)&&ed.getFullYear()>2020){console.log('extractETA: embedded date in event=',embeddedDate[1]);return ed.toISOString().substring(0,10)}
            }
            const embDate2=desc.match(/(\d{4}[\-\/]\d{2}[\-\/]\d{2})/);
            if(embDate2){console.log('extractETA: ISO date in event=',embDate2[1]);return embDate2[1]}
          }
        }
      }
      // 1. For delivered: use most recent event date
      const sts=(info.status||'').toLowerCase();
      if(sts.includes('deliver')&&info.states&&info.states.length>0){
        const lastState=info.states[0];
        if(lastState.date)return lastState.date.substring(0,10);
      }
      // 2. Search events for ETA/arrival hints (NOT departure events)
      // For containers, only use the MOST RECENT matching event (newest first)
      if(info.states){
        for(const st of info.states){
          const desc=(st.status||'').toLowerCase();
          // Only match arrival/estimate events, explicitly exclude departure and loading events
          if(desc.includes('depart')||desc.includes('loaded')||desc.includes('gate out')||desc.includes('gate-out'))continue;
          if((desc.includes('estimat')||desc.includes('expect')||desc.includes('arrival')||desc.includes('arrived')||desc.includes('discharg'))&&st.date){
            console.log('extractETA: using event "'+st.status+'" date=',st.date.substring(0,10));
            return st.date.substring(0,10);
          }
        }
      }
      return null;
    }
    // === LEGACY 17Track FORMAT ===
    const ed=info.track_info?.time_metrics?.estimated_delivery_date;
    if(ed){if(typeof ed==='string')return ed.substring(0,10);if(ed.from)return ed.from.substring(0,10);if(ed.to)return ed.to.substring(0,10)}
    if(info.track_info?.latest_status?.status==='Delivered'){
      const evt=info.track_info?.latest_event;if(evt?.time_iso)return evt.time_iso.substring(0,10);
      const events=(info.track_info?.tracking?.providers||[])[0]?.events||[];
      for(const ev of events){
        if((ev.description||'').toLowerCase().includes('deliver')&&ev.time_iso)return ev.time_iso.substring(0,10);
      }
      if(events.length>0&&events[0].time_iso)return events[0].time_iso.substring(0,10);
    }
    const latestEvt=info.track_info?.latest_event;
    if(latestEvt?.time_iso){
      const events=(info.track_info?.tracking?.providers||[])[0]?.events||[];
      if(events.length>0){
        for(const ev of events){
          const desc=(ev.description||'').toLowerCase();
          if((desc.includes('estimat')||desc.includes('expect')||desc.includes('arrival')||desc.includes('eta'))&&ev.time_iso)return ev.time_iso.substring(0,10);
        }
        const sts=info.track_info?.latest_status?.status;
        if(sts==='Delivered'&&events[0]?.time_iso)return events[0].time_iso.substring(0,10);
      }
    }
  }catch(e){}return null;
}
function extractStatusFromTracking(info){
  try{
    // === PARCELS APP API FORMAT ===
    if(info.states||info.trackingId){
      // PRIORITY: Check latest events FIRST for delivery — API top-level status can lag behind
      if(info.states&&info.states.length>0){
        // Scan recent events (top 3) for delivery keywords
        for(let i=0;i<Math.min(3,info.states.length);i++){
          const desc=(info.states[i].status||'').toLowerCase();
          if(desc.includes('deliver'))return'Delivered';
        }
      }
      // Then check top-level status
      const s=info.status;
      if(s){
        const sl=s.toLowerCase();
        if(sl.includes('deliver'))return'Delivered';
        if(sl.includes('transit'))return'In Transit';
        if(sl.includes('pickup')||sl.includes('picked'))return'Picked Up';
        if(sl.includes('exception')||sl.includes('fail'))return'Exception';
        if(sl.includes('info received')||sl.includes('pending'))return'Info Received';
        if(sl.includes('out for delivery'))return'Out for Delivery';
        if(sl.includes('expired'))return'Expired';
        return s;
      }
      // Fallback: check latest event for general status
      if(info.states&&info.states.length>0){
        const desc=(info.states[0].status||'').toLowerCase();
        if(desc.includes('transit')||desc.includes('depart')||desc.includes('arrive'))return'In Transit';
        if(desc.includes('pickup')||desc.includes('picked'))return'Picked Up';
        return'In Transit';
      }
      return null;
    }
    // === LEGACY 17Track FORMAT ===
    const s=info.track_info?.latest_status?.status;
    const map={NotFound:'Not Found',InfoReceived:'Info Received',InTransit:'In Transit',OutForDelivery:'Out for Delivery',Delivered:'Delivered',Exception:'Exception',FailedAttempt:'Failed Attempt',Expired:'Expired',PickedUp:'Picked Up',Undelivered:'Undelivered'};
    if(s)return map[s]||s;
    const desc=(info.track_info?.latest_event?.description||'').toLowerCase();
    if(desc.includes('deliver'))return'Delivered';
    if(desc.includes('transit')||desc.includes('depart')||desc.includes('arrive'))return'In Transit';
    if(desc.includes('pickup')||desc.includes('picked up'))return'Picked Up';
    if(desc.includes('exception')||desc.includes('failed'))return'Exception';
    const events=(info.track_info?.tracking?.providers||[])[0]?.events||[];
    if(events.length>0)return'In Transit';
    return null;
  }catch(e){}return null;
}
function cleanTrk(t){return(t||'').replace(/\s+/g,'').trim()}
function getEffectiveETA(r){
  const t=cleanTrk(r.trk);
  // Check by tracking/BL number first
  if(t&&TRACKED_ETA[t])return TRACKED_ETA[t];
  // Also check by container number (for sea freight where trk is BL but tracking saved under container)
  if(r.cont){const cn=extractContainerNum(r.cont);if(cn&&TRACKED_ETA[cn])return TRACKED_ETA[cn]}
  return r.eta;
}
function isTrackedETA(r){
  const t=cleanTrk(r.trk);
  if(t&&TRACKED_ETA[t])return true;
  if(r.cont){const cn=extractContainerNum(r.cont);if(cn&&TRACKED_ETA[cn])return true}
  return false;
}

function trkUrl(n,mode){
  if(!n)return'#';const m=(mode||'').toLowerCase();n=n.replace(/\s+/g,'').trim();
  // Container number detection — use carrier-specific tracking page
  if(isContainerNum(n)){
    const ct=getContainerTrackUrl(n);
    return ct.url;
  }
  // Sea mode with container-like tracking numbers
  if(isSea({mode})&&/^[A-Z]{4}\d/i.test(n)){
    const ct=getContainerTrackUrl(n);
    return ct.url;
  }
  if(n.match(/^1Z/i))return'https://www.ups.com/track?tracknum='+n;
  if(isAWB(n))return'https://parcelsapp.com/en/tracking/'+n;
  if(n.length>=12&&n.match(/^\d+$/))return'https://www.fedex.com/fedextrack/?trknbr='+n;
  if(n.match(/^\d{10}$/))return'https://www.dhl.com/en/express/tracking.html?AWB='+n;
  return'https://parcelsapp.com/en/tracking/'+n;
}

// ============ PARCELS APP API ============
// Universal tracking API — handles parcels, AWBs, containers, vessels automatically
// Parcels API REQUIRES "country" (destination) on every shipment — default to DE (Germany)
// Field name is "country" NOT "destinationCountry" per Parcels API v3
const LOC_TO_ORIGIN={'STS China':'CN','STS Thai':'TH','STS Bali':'ID','STS Jewels':'IN',
  'VGL Jaipur':'IN','VGL Mumbai':'IN','Direct UK':'GB','Direct Others':'CN'};
function getOriginCountry(loc){return LOC_TO_ORIGIN[loc]||null}
const DEFAULT_DEST_ZIP='40233'; // Default destination postal code (Düsseldorf) for carriers like GLS
function isGLS(mode,trk){const m=(mode||'').toLowerCase();const t=(trk||'').toLowerCase();return m.includes('gls')||t.includes('gls')}

async function apiCallParcels(trackingIds,options){
  options=options||{};
  const destCountry=options.country||options.destinationCountry||'DE';
  const originCountry=options.originCountry||null;
  const shipments=trackingIds.map(id=>{
    const s=typeof id==='string'?{trackingId:id}:Object.assign({},id);
    // REQUIRED: "country" field — Parcels API rejects without it
    if(!s.country)s.country=s.destinationCountry||destCountry;
    delete s.destinationCountry; // API uses "country", not "destinationCountry"
    if(!s.origin&&originCountry)s.origin=originCountry;
    // GLS and some carriers require postal code for tracking
    if(!s.zipCode&&options.zipCode)s.zipCode=options.zipCode;
    return s;
  });
  console.log('Parcels API request:',shipments.length,'shipments, country:',destCountry);
  // Try Netlify function (handles server-side polling)
  try{
    const r=await fetch('/.netlify/functions/track',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({shipments:shipments,apiKey:PARCELS_API_KEY,language:'en'})});
    if(r.ok){const j=await r.json();if(j.error){console.warn('Netlify track error:',j.error,j.description);throw new Error(j.description||j.error)}return j}
  }catch(e){console.warn('Netlify track function failed:',e.message)}
  // Fallback: direct API call (may have CORS issues)
  try{
    const r=await fetch(PARCELS_API,{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({shipments:shipments,apiKey:PARCELS_API_KEY,language:'en'})});
    if(r.ok){
      const postData=await r.json();
      if(postData.error){console.warn('Parcels API error:',postData.error,postData.description);throw new Error(postData.description||postData.error)}
      if(postData.done)return postData;
      if(postData.uuid){
        // Poll for results
        for(let i=0;i<6;i++){
          await new Promise(r=>setTimeout(r,2500));
          const gr=await fetch(PARCELS_API+'?apiKey='+encodeURIComponent(PARCELS_API_KEY)+'&uuid='+encodeURIComponent(postData.uuid),{headers:{'Accept':'application/json'}});
          if(gr.ok){const gd=await gr.json();if(gd.done)return gd;if(gd.shipments&&gd.shipments.some(s=>s.states&&s.states.length>0))return{...gd,done:true}}
        }
      }
      return postData;
    }
  }catch(e){console.warn('Direct Parcels API failed:',e.message)}
  throw new Error('Parcels API: all methods failed');
}

function fmtTrk(info){
  try{
    // Handle BOTH Parcels API format and legacy 17Track/manual format
    // Parcels format: {trackingId, status, states:[], attributes:[], origin, destination}
    // Legacy format: {track_info:{latest_status, latest_event, tracking:{providers:[{events}]}}}
    if(info.states||info.trackingId){
      return fmtParcels(info);
    }
    if(info.track_info){
      return fmtLegacy(info);
    }
    // Try both
    return'<span style="color:var(--t2)">Tracking data format not recognized</span>';
  }catch(e){return'<span style="color:var(--or)">Error formatting: '+e.message+'</span>'}
}
// Format Parcels App API response
function fmtParcels(ship){
  const sts=ship.status||'Unknown';
  const stsColors={Delivered:'var(--gn)',delivered:'var(--gn)','In Transit':'var(--ac)','in transit':'var(--ac)',InTransit:'var(--ac)','Out for Delivery':'#22d3ee',Exception:'var(--rd)',InfoReceived:'var(--or)','Info Received':'var(--or)',NotFound:'var(--t2)',Expired:'var(--t2)','Picked Up':'var(--ac)'};
  const color=stsColors[sts]||'var(--ac)';
  let h=`<div style="margin-bottom:8px"><span style="font-weight:800;font-size:16px;color:${color}">${sts}</span>`;
  if(ship.carrier)h+=` <span style="color:var(--t2);font-size:12px">(${ship.carrier})</span>`;
  h+='</div>';
  // Latest event
  if(ship.states&&ship.states.length>0){
    const latest=ship.states[0];
    if(latest.status)h+=`<div style="font-size:13px;color:var(--tx);margin-bottom:6px;font-weight:500">\u{1F4CD} ${latest.status}</div>`;
    if(latest.date)h+=`<div style="font-size:12px;color:var(--t2);margin-bottom:3px">\u{1F552} ${latest.date.replace('T',' ').substring(0,16)}</div>`;
    if(latest.location)h+=`<div style="font-size:12px;color:var(--t2)">\u{1F4CD} ${latest.location}</div>`;
  }
  // Attributes (weight, origin, destination, etc.)
  if(ship.attributes&&ship.attributes.length>0){
    h+='<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;padding:8px 0;border-top:1px solid rgba(71,85,105,.2)">';
    ship.attributes.forEach(a=>{
      if(a.l&&a.val)h+=`<div style="font-size:11px"><span style="color:var(--t2)">${a.l}:</span> <span style="color:var(--tx);font-weight:600">${a.val}</span></div>`;
    });
    h+='</div>';
  }
  // Show extracted ETA prominently
  const extractedEta=extractETAFromTracking(ship);
  if(extractedEta){
    h+=`<div style="font-size:13px;color:#22d3ee;margin-top:8px;font-weight:700;background:rgba(34,211,238,.08);padding:6px 10px;border-radius:6px;border:1px solid rgba(34,211,238,.2)">\u{1F4C5} Estimated Delivery: ${extractedEta}</div>`;
  }
  // Origin/destination
  if(ship.origin||ship.destination){
    h+=`<div style="font-size:12px;color:#22d3ee;margin-top:6px;font-weight:600">`;
    if(ship.origin)h+=`\u{1F6EB} ${ship.origin} `;
    if(ship.origin&&ship.destination)h+=`\u27A1 `;
    if(ship.destination)h+=`\u{1F6EC} ${ship.destination}`;
    h+=`</div>`;
  }
  // All events
  if(ship.states&&ship.states.length>1){
    h+='<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12px;color:var(--ac);font-weight:600">\u{1F4CB} Show all '+ship.states.length+' tracking events</summary><div style="max-height:280px;overflow-y:auto;margin-top:6px">';
    ship.states.slice(0,30).forEach(ev=>{
      h+=`<div style="font-size:12px;padding:6px 0;border-bottom:1px solid rgba(71,85,105,.2)"><span style="color:var(--t2);font-size:11px">${(ev.date||'').replace('T',' ').substring(0,16)}</span>`;
      if(ev.location)h+=` <span style="color:var(--t2);font-size:10px">\u{1F4CD}${ev.location}</span>`;
      h+=`<br><span style="color:var(--tx)">${ev.status||''}</span></div>`;
    });
    h+='</div></details>';
  }
  return h;
}
// Format legacy 17Track / manual format
function fmtLegacy(info){
  const ti=info.track_info||{};const ls=ti.latest_status||{};const le=ti.latest_event||{};
  const sts=ls.status||'Unknown';const sub=ls.sub_status||'';
  const stsColors={Delivered:'var(--gn)',InTransit:'var(--ac)',OutForDelivery:'#22d3ee',Exception:'var(--rd)',InfoReceived:'var(--or)',NotFound:'var(--t2)',FailedAttempt:'var(--rd)',Expired:'var(--t2)'};
  const color=stsColors[sts]||'var(--t2)';
  let h=`<div style="margin-bottom:8px"><span style="font-weight:800;font-size:16px;color:${color}">${sts}</span>`;
  if(sub)h+=` <span style="color:var(--t2);font-size:12px">(${sub})</span>`;
  h+='</div>';
  if(le.description)h+=`<div style="font-size:13px;color:var(--tx);margin-bottom:6px;font-weight:500">\u{1F4CD} ${le.description}</div>`;
  if(le.time_iso)h+=`<div style="font-size:12px;color:var(--t2);margin-bottom:3px">\u{1F552} ${le.time_iso.replace('T',' ').substring(0,16)}</div>`;
  if(le.location)h+=`<div style="font-size:12px;color:var(--t2)">\u{1F4CD} ${le.location}</div>`;
  const ed=ti.time_metrics?.estimated_delivery_date;
  if(ed){const eta=typeof ed==='string'?ed.substring(0,10):ed.from?ed.from.substring(0,10):'';if(eta)h+=`<div style="font-size:13px;color:#22d3ee;margin-top:8px;font-weight:600">\u{1F4C5} ETA: ${eta}</div>`}
  const events=(ti.tracking?.providers||[])[0]?.events||[];
  if(events.length>1){h+='<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12px;color:var(--ac);font-weight:600">\u{1F4CB} Show all '+events.length+' tracking events</summary><div style="max-height:280px;overflow-y:auto;margin-top:6px">';
    events.slice(0,20).forEach(ev=>{h+=`<div style="font-size:12px;padding:6px 0;border-bottom:1px solid rgba(71,85,105,.2)"><span style="color:var(--t2);font-size:11px">${(ev.time_iso||'').replace('T',' ').substring(0,16)}</span><br><span style="color:var(--tx)">${ev.description||''}</span></div>`});
    h+='</div></details>'}
  return h;
}

function buildCarrierLinks(num,mode,cont){
  num=(num||'').replace(/\s+/g,'').trim();
  const m=(mode||'').toLowerCase();let h='<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">';
  if(m.includes('ups')||/^1Z/i.test(num))h+=`<a href="https://www.ups.com/track?tracknum=${num}" target="_blank" class="trk-link">\u{1F4E6} UPS \u2197</a>`;
  else if(m.includes('fedex'))h+=`<a href="https://www.fedex.com/fedextrack/?trknbr=${num}" target="_blank" class="trk-link">\u{1F4E6} FedEx \u2197</a>`;
  else if(m.includes('dhl'))h+=`<a href="https://www.dhl.com/en/express/tracking.html?AWB=${num}" target="_blank" class="trk-link">\u{1F4E6} DHL \u2197</a>`;
  if(isAWB(num)){
    const clean=num.replace(/[-\s]/g,'');const prefix=clean.substring(0,3);
    const awbLinks={'157':'https://www.qrcargo.com/s/track-your-shipment','176':'https://www.skycargo.com/track-shipments','235':'https://www.turkishcargo.com/en/track-trace','020':'https://www.lufthansa-cargo.com/tracking','057':'https://cargo.airfrance.com/tracking','125':'https://www.iagcargo.com/en/track-and-trace'};
    if(awbLinks[prefix])h+=`<a href="${awbLinks[prefix]}" target="_blank" class="trk-link">\u2708\uFE0F Airline Cargo \u2197</a>`;
  }
  // Container carrier links — detect from tracking number or container field
  const contRef=cont||num;
  if(isContainerNum(num)||isContainerNum(contRef)){
    const ct=getContainerTrackUrl(isContainerNum(num)?num:contRef);
    if(ct.carrier.code!=='GENERIC'){
      h+=`<a href="${ct.url}" target="_blank" class="trk-link">\u{1F6A2} ${ct.carrier.name} \u2197</a>`;
    }
    // Add all major carrier links for this container
    const cNum=ct.contNum;
    h+=`<a href="https://www.maersk.com/tracking/${cNum}" target="_blank" class="trk-link">\u{1F6A2} Maersk \u2197</a>`;
    h+=`<a href="https://www.hapag-lloyd.com/en/online-business/track/track-by-container-solution.html?container=${cNum}" target="_blank" class="trk-link">\u{1F6A2} Hapag-Lloyd \u2197</a>`;
    h+=`<a href="https://www.track-trace.com/container?number=${cNum}" target="_blank" class="trk-link">\u{1F50D} Track-Trace \u2197</a>`;
  }
  h+=`<a href="https://parcelsapp.com/en/tracking/${num}" target="_blank" class="trk-link">\u{1F50D} Parcels App \u2197</a></div>`;return h;
}

async function trackOne(num,mode,idx,cont){
  num=(num||'').replace(/\s+/g,'').trim();
  if(!num){const el=document.getElementById('trkRes'+idx);if(el){el.style.display='block';el.innerHTML='<span style="color:var(--t2)">No tracking number</span>'}return}
  const el=document.getElementById('trkRes'+idx);if(el){el.style.display='block';el.innerHTML='<span style="color:var(--or)">\u23F3 Tracking...</span>'}
  // Look up origin country from the shipment row for better Parcels API detection
  const allTransit=FD.filter(r=>isTrans(r));
  const row=allTransit[idx];
  const originCC=row?getOriginCountry(row.loc):null;
  const apiOpts=originCC?{originCountry:originCC}:{};
  try{
    const cache=JSON.parse(localStorage.getItem('TRACK_CACHE')||'{}');

    // ---- 3-HOUR COOLDOWN CHECK (prevents excessive API costs) ----
    const cooldownKey=cleanTrk(num);
    const contNumCool=cont?extractContainerNum(cont):null;
    // Check cooldown by BOTH BL number AND container number
    const cdKey=(cooldownKey&&TRACKED_TS[cooldownKey])?cooldownKey:((contNumCool&&TRACKED_TS[contNumCool])?contNumCool:cooldownKey);
    if(cdKey&&TRACKED_TS[cdKey]&&(Date.now()-TRACKED_TS[cdKey])<TRACK_COOLDOWN){
      // Already tracked within 3 hours — show cached data instead of calling API
      const cachedData=cache[cdKey]||cache[cooldownKey]||cache[contNumCool];
      if(cachedData&&cachedData.data){
        // Re-extract ETA with latest logic — ALWAYS save under ALL keys to keep in sync
        const freshEta=extractETAFromTracking(cachedData.data);
        const freshSts=extractStatusFromTracking(cachedData.data);
        if(freshEta){
          console.log('Cooldown re-extract: syncing ETA for',cdKey,'=',freshEta,'(was:',TRACKED_ETA[cdKey],')');
          saveTrackedInfo(cdKey,freshEta,freshSts);
          // Also save under BL number AND container number
          if(cooldownKey&&cooldownKey!==cdKey)saveTrackedInfo(cooldownKey,freshEta,freshSts);
          if(contNumCool&&contNumCool!==cdKey)saveTrackedInfo(contNumCool,freshEta,freshSts);
          if(initialized)renderAll();
        }
        if(el)el.innerHTML='<div style="font-size:11px;color:#22d3ee;margin-bottom:6px">\u2705 Already tracked '+timeAgo(TRACKED_TS[cdKey])+' (3h cooldown active)</div>'+fmtTrk(cachedData.data)+buildManualSavePanel(num,idx,mode,cont);
        return;
      }
      // No cached data but we have timestamp — just show message
      if(el){el.innerHTML='<span style="color:#22d3ee">\u2705 Tracked '+timeAgo(TRACKED_TS[cdKey])+'. Next refresh available in '+Math.ceil((TRACK_COOLDOWN-(Date.now()-TRACKED_TS[cdKey]))/60000)+'min</span>'}
      return;
    }

    // ---- CONTAINER / SEA FREIGHT ----
    // IMPORTANT: For sea shipments, `num` (trk field) is often a BL number like "263434637"
    // The ACTUAL container number is in the `cont` field like "MSK - CAAU4896044"
    // We MUST send the container number to Parcels API, NOT the BL number
    const contNum=cont?extractContainerNum(cont):null;
    const isContainer=isContainerNum(num)||(isSea({mode})&&contNum);
    if(isContainer){
      // Always prefer the extracted container number over the trk field
      const trackContNum=contNum||num;
      console.log('Container detected: trk=',num,'contField=',cont,'→ sending to API:',trackContNum);
      const ct=getContainerTrackUrl(cont||num);

      // Check cache by CONTAINER number (not BL number)
      if(cache[trackContNum]&&(Date.now()-cache[trackContNum].ts)<14400000){
        // Re-extract ETA with latest logic
        const cEta=extractETAFromTracking(cache[trackContNum].data);
        const cSts=extractStatusFromTracking(cache[trackContNum].data);
        // ALWAYS save under both container AND BL number to keep them in sync
        if(cEta){
          saveTrackedInfo(trackContNum,cEta,cSts);
          if(trackContNum!==num)saveTrackedInfo(num,cEta,cSts);
          if(initialized)renderAll();
        }
        if(el)el.innerHTML=fmtTrk(cache[trackContNum].data)+buildManualSavePanel(num,idx,mode,cont);return;
      }

      // Try Parcels API with the CONTAINER number
      let apiSuccess=false;
      if(trackContNum){
        try{
          const result=await apiCallParcels([trackContNum],apiOpts);
          if(result&&result.shipments&&result.shipments.length>0){
            const ship=result.shipments[0];
            if(hasTrackingData(ship)){
              // Save under BOTH the container number AND BL number for cross-reference
              // saveTrackResult saves to cache + TRACKED_ETA/STS/TS + Firebase
              saveTrackResult(trackContNum,ship,cache);
              // Also save ETA/status under BL number so getEffectiveETA(r) finds it by r.trk
              if(trackContNum!==num){
                const courierETA=extractETAFromTracking(ship);
                const courierSts=extractStatusFromTracking(ship);
                saveTrackedInfo(num,courierETA,courierSts);
                cache[num]={ts:Date.now(),data:ship};try{localStorage.setItem('TRACK_CACHE',JSON.stringify(cache))}catch(e){}
              }
              if(el)el.innerHTML=fmtTrk(ship)+buildManualSavePanel(num,idx,mode,cont);
              apiSuccess=true;
            }
          }
        }catch(e){console.warn('Container API tracking failed:',e.message)}
      }
      // If API failed, try showing cached data first before falling back to iframe popup
      if(!apiSuccess){
        const fallbackCache=cache[trackContNum]||cache[num]||cache[contNumCool];
        if(fallbackCache&&fallbackCache.data){
          // Re-extract ETA with latest logic
          const fbEta=extractETAFromTracking(fallbackCache.data);
          const fbSts=extractStatusFromTracking(fallbackCache.data);
          if(fbEta){saveTrackedInfo(trackContNum,fbEta,fbSts);if(trackContNum!==num)saveTrackedInfo(num,fbEta,fbSts);if(initialized)renderAll()}
          if(el)el.innerHTML='<div style="font-size:11px;color:var(--or);margin-bottom:6px">\u26A0 API unavailable — showing cached data</div>'+fmtTrk(fallbackCache.data)+buildManualSavePanel(num,idx,mode,cont);
        }else if(el){
          el.innerHTML=buildContainerPopup(num,ct,idx,mode,cont);
        }
      }
      return;
    }

    // Non-container cache check (BL, AWB, parcel numbers)
    if(cache[num]&&(Date.now()-cache[num].ts)<14400000){if(el)el.innerHTML=fmtTrk(cache[num].data)+buildManualSavePanel(num,idx,mode,cont);return}

    // ---- AWB / AIR CARGO ----
    if(isAWB(num)){
      console.log('AWB detected:',num,'— using Parcels API');
      if(el)el.innerHTML='<span style="color:var(--or)">\u23F3 Tracking air cargo...</span>';
      try{
        const result=await apiCallParcels([num],apiOpts);
        if(result&&result.shipments&&result.shipments.length>0){
          const ship=result.shipments[0];
          if(hasTrackingData(ship)){
            saveTrackResult(num,ship,cache);
            if(el)el.innerHTML=fmtTrk(ship)+buildManualSavePanel(num,idx,mode,cont);return;
          }
        }
      }catch(e){console.warn('AWB Parcels API failed:',e.message)}
      // AWB: show airline cargo page + quick save panel
      if(el){
        const clean=num.replace(/[-\s]/g,'');const prefix=clean.substring(0,3);
        const awbLinks={'157':'https://www.qrcargo.com/s/track-your-shipment','176':'https://www.skycargo.com/track-shipments','235':'https://www.turkishcargo.com/en/track-trace','020':'https://www.lufthansa-cargo.com/tracking','057':'https://cargo.airfrance.com/tracking','125':'https://www.iagcargo.com/en/track-and-trace'};
        const awbUrl=awbLinks[prefix]||('https://www.track-trace.com/aircargo?number='+encodeURIComponent(num));
        el.innerHTML=buildTrackingPopup(num,awbUrl,'\u2708\uFE0F','Air Cargo',idx,mode,cont);
      }
      return;
    }

    // ---- STANDARD TRACKING (UPS, FedEx, DHL, etc.) ----
    // GLS and carriers needing postal code — add zipCode to options
    const glsOpts=isGLS(mode,num)?Object.assign({},apiOpts,{zipCode:DEFAULT_DEST_ZIP}):apiOpts;
    console.log('Tracking via Parcels API:',num,'mode:',mode,'origin:',originCC,isGLS(mode,num)?'(GLS w/ zip '+DEFAULT_DEST_ZIP+')':'');
    try{
      const result=await apiCallParcels([num],glsOpts);
      if(result&&result.shipments&&result.shipments.length>0){
        const ship=result.shipments[0];
        if(hasTrackingData(ship)){
          saveTrackResult(num,ship,cache);
          if(el)el.innerHTML=fmtTrk(ship)+buildManualSavePanel(num,idx,mode,cont);return;
        }
      }
      if(result&&result.error){
        if(el)el.innerHTML='<div style="margin-bottom:6px"><span style="color:var(--or)">\u26A0 '+result.error+'</span></div>'+buildManualSavePanel(num,idx,mode,cont)+buildCarrierLinks(num,mode,cont);return;
      }
    }catch(e){console.warn('Parcels API failed:',e.message)}
    // No data from API — show manual save
    if(el)el.innerHTML='<div style="margin-bottom:6px"><span style="color:var(--t2)">No tracking info available yet</span></div>'+buildManualSavePanel(num,idx,mode,cont)+buildCarrierLinks(num,mode,cont);
  }catch(e){
    if(el)el.innerHTML='<div style="margin-bottom:6px"><span style="color:var(--or)">\u26A0 '+e.message+'</span></div>'+buildManualSavePanel(num,idx,mode,cont)+buildCarrierLinks(num,mode,cont);
  }
}

// Build the manual save panel (used for ALL shipment types when API fails or as secondary option)
function buildManualSavePanel(num,idx,mode,cont){
  const today=new Date().toISOString().substring(0,10);
  return '<div style="padding:12px 14px;background:linear-gradient(135deg,rgba(16,185,129,0.08),rgba(59,130,246,0.08));border:1px solid rgba(16,185,129,0.3);border-radius:12px;margin-top:10px">'+
    '<div style="font-size:13px;font-weight:700;color:#10b981;margin-bottom:8px">\u{1F4BE} Update Status & ETA Manually</div>'+
    '<div style="font-size:11px;color:var(--t2);margin-bottom:10px">View the tracking details above or in the carrier page, then save status and date here:</div>'+
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'+
      '<select id="awbSts_'+idx+'" style="padding:6px 10px;border-radius:8px;border:1px solid rgba(148,163,184,0.3);background:var(--cd);color:var(--tx);font-size:12px;font-weight:600">'+
        '<option value="">-- Status --</option>'+
        '<option value="Delivered">Delivered</option>'+
        '<option value="In Transit" selected>In Transit</option>'+
        '<option value="Info Received">Info Received</option>'+
        '<option value="Out for Delivery">Out for Delivery</option>'+
        '<option value="Arrived at Port">Arrived at Port</option>'+
        '<option value="Customs Clearance">Customs Clearance</option>'+
        '<option value="On Vessel">On Vessel</option>'+
        '<option value="Departed Port">Departed Port</option>'+
        '<option value="Exception">Exception</option>'+
        '<option value="Picked Up">Picked Up</option>'+
      '</select>'+
      '<input type="date" id="awbEta_'+idx+'" value="'+today+'" style="padding:6px 10px;border-radius:8px;border:1px solid rgba(148,163,184,0.3);background:var(--cd);color:var(--tx);font-size:12px;font-weight:600"/>'+
      '<button onclick="saveAWBManual(\''+num.replace(/'/g,'')+'\','+idx+',\''+(cont||'').replace(/'/g,'')+'\')" style="padding:6px 16px;background:linear-gradient(135deg,#10b981,#059669);color:#fff;border:none;border-radius:8px;font-weight:700;font-size:12px;cursor:pointer;white-space:nowrap">\u2705 Save to Dashboard</button>'+
      '<span id="awbSaveMsg_'+idx+'" style="font-size:11px;font-weight:600"></span>'+
    '</div>'+
  '</div>';
}

// Build container tracking popup with carrier page iframe + manual save
function buildContainerPopup(num,ct,idx,mode,cont){
  const contNum=ct.contNum;
  const carrierName=ct.carrier.name||'Container';
  const carrierUrl=ct.url;
  return '<div style="margin-bottom:8px">'+
    buildManualSavePanel(num,idx,mode,cont)+
    '<div style="display:flex;align-items:center;gap:8px;margin:10px 0 8px 0">'+
      '<span style="font-size:13px;color:var(--t2)">\u{1F6A2} <b>'+carrierName+'</b> tracking for <b>'+contNum+'</b></span>'+
      '<a href="'+carrierUrl+'" target="_blank" style="font-size:12px;color:var(--ac);text-decoration:none;font-weight:600">\u2197 Open in new tab</a>'+
    '</div>'+
    '<iframe src="'+carrierUrl+'" style="width:100%;height:600px;border:1px solid rgba(128,128,128,0.2);border-radius:10px;background:#fff" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups allow-forms" referrerpolicy="no-referrer"></iframe>'+
    '<div style="margin-top:8px">'+buildCarrierLinks(num,mode,cont)+'</div>'+
  '</div>';
}

// Build generic tracking popup with iframe + manual save (for AWBs etc)
function buildTrackingPopup(num,url,icon,label,idx,mode,cont){
  return '<div style="margin-bottom:8px">'+
    buildManualSavePanel(num,idx,mode,cont)+
    '<div style="display:flex;align-items:center;gap:8px;margin:10px 0 8px 0">'+
      '<span style="font-size:13px;color:var(--t2)">'+icon+' '+label+' tracking for <b>'+num+'</b></span>'+
      '<a href="'+url+'" target="_blank" style="font-size:12px;color:var(--ac);text-decoration:none">\u2197 Open in new tab</a>'+
    '</div>'+
    '<iframe src="'+url+'" style="width:100%;height:520px;border:1px solid rgba(128,128,128,0.2);border-radius:10px;background:#fff" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups" referrerpolicy="no-referrer"></iframe>'+
    '<div style="margin-top:8px">'+buildCarrierLinks(num,mode,cont)+'</div>'+
  '</div>';
}
// AWB tracking via Parcels App API — handles air cargo natively
async function trackAWB(num){
  console.log('AWB trackAWB() called for:',num);
  // Check cache first
  try{
    const cache=JSON.parse(localStorage.getItem('TRACK_CACHE')||'{}');
    if(cache[num]&&cache[num].data&&(Date.now()-cache[num].ts)<86400000){
      console.log('AWB: found cached tracking data for',num,'from',timeAgo(cache[num].ts));
      if(hasTrackingData(cache[num].data))return{method:'cache',data:cache[num].data};
    }
  }catch(e){}
  // Use Parcels API — it handles AWBs natively
  try{
    console.log('AWB: tracking via Parcels API...');
    const result=await apiCallParcels([num],{destinationCountry:'DE'});
    if(result&&result.shipments&&result.shipments.length>0){
      const ship=result.shipments[0];
      if(hasTrackingData(ship)){
        console.log('AWB: Parcels API has data!');
        return{method:'api',data:ship};
      }
    }
  }catch(e){console.warn('AWB Parcels API failed:',e.message)}
  console.log('AWB: no data from Parcels API for',num);
  return null;
}
function hasTrackingData(info){
  // Parcels format
  if(info.states||info.trackingId){
    return(info.states&&info.states.length>0)||(info.status&&!info.status.toLowerCase().includes('not found'));
  }
  // Legacy 17Track format
  const events=(info.track_info?.tracking?.providers||[])[0]?.events||[];
  const sts=info.track_info?.latest_status?.status;
  return events.length>0||(sts&&sts!=='NotFound');
}
function saveTrackResult(origNum,info,cache){
  cache[origNum]={ts:Date.now(),data:info};
  try{localStorage.setItem('TRACK_CACHE',JSON.stringify(cache))}catch(e){}
  const courierETA=extractETAFromTracking(info);
  const courierSts=extractStatusFromTracking(info);
  console.log('saveTrackResult:',origNum,'ETA:',courierETA,'Status:',courierSts);
  saveTrackedInfo(origNum,courierETA,courierSts);
  saveTrackCacheToFirebase(origNum,info);
}
function getAWBVariants(num){
  const clean=num.replace(/[-\s]/g,'');
  const variants=new Set();
  variants.add(num);variants.add(clean);
  if(clean.length===11)variants.add(clean.substring(0,3)+'-'+clean.substring(3));
  return[...variants];
}
// Manual save — user enters status & date from what they see on carrier page
function saveAWBManual(num,idx,cont){
  const stsEl=document.getElementById('awbSts_'+idx);
  const etaEl=document.getElementById('awbEta_'+idx);
  const msgEl=document.getElementById('awbSaveMsg_'+idx);
  if(!stsEl||!etaEl)return;
  const sts=stsEl.value;
  const eta=etaEl.value;
  if(!sts&&!eta){if(msgEl){msgEl.style.color='#f87171';msgEl.textContent='\u26A0 Please select status and/or date'}return}
  console.log('saveAWBManual:',num,'cont:',cont,'status:',sts,'eta:',eta);
  // Save to Firebase + localStorage via existing functions — save under BOTH BL and container
  saveTrackedInfo(num,eta||null,sts||null);
  // Also save under container number if available
  if(cont){const cn=extractContainerNum(cont);if(cn&&cn!==num)saveTrackedInfo(cn,eta||null,sts||null)}
  // Create a synthetic Parcels-format object and save to cache
  const syntheticInfo={
    trackingId:num,
    status:sts||'In Transit',
    states:[{date:eta?eta+'T00:00:00':'',status:'Status: '+sts+' (manually saved)',location:''}],
    attributes:eta?[{l:'ETA',val:eta}]:[]
  };
  try{
    const cache=JSON.parse(localStorage.getItem('TRACK_CACHE')||'{}');
    cache[num]={ts:Date.now(),data:syntheticInfo};
    localStorage.setItem('TRACK_CACHE',JSON.stringify(cache));
  }catch(e){}
  saveTrackCacheToFirebase(num,syntheticInfo);
  // Update UI
  if(msgEl){msgEl.style.color='#10b981';msgEl.textContent='\u2705 Saved! Dashboard will update.'}
  // Refresh dashboard display
  if(initialized)renderAll();
}

async function trackAll17(filter){
  filter=filter||'all';
  let tr=FD.filter(r=>isTrans(r)&&r.trk);
  if(filter==='air')tr=tr.filter(r=>isAir(r));
  else if(filter==='sea')tr=tr.filter(r=>isSea(r));
  if(!tr.length){document.getElementById('trkStatus').textContent='No '+(filter==='all'?'':filter+' ')+'trackable shipments';return}
  const st=document.getElementById('trkStatus');
  const stale=tr.filter(r=>{const ct=cleanTrk(r.trk);return!ct||!TRACKED_TS[ct]||(Date.now()-TRACKED_TS[ct])>=TRACK_COOLDOWN});
  const skipped=tr.length-stale.length;
  if(!stale.length){st.innerHTML='<span style="color:var(--gn)">\u2705 All '+tr.length+' '+(filter==='all'?'':filter+' ')+'shipments tracked recently (within 3h).</span>';return}
  st.innerHTML='<span style="color:var(--or)">Starting '+(filter==='all'?'all':filter)+': '+stale.length+' to track'+(skipped?' ('+skipped+' skipped \u2014 tracked <3h ago)':'')+'</span>';

  // Batch tracking via Parcels API — send up to 10 at a time
  const allTransit=FD.filter(r=>isTrans(r));
  const batchSize=10;
  let tracked=0;
  for(let b=0;b<stale.length;b+=batchSize){
    const batch=stale.slice(b,b+batchSize);
    st.innerHTML='<span style="color:var(--or)">\u{1F50D} Tracking '+(b+1)+'-'+Math.min(b+batchSize,stale.length)+'/'+stale.length+' '+(filter==='all'?'':filter)+'...'+(skipped?' ('+skipped+' skipped)':'')+'</span>';
    // Separate containers (need carrier popup) from regular tracking numbers
    const regularNums=[];const containerItems=[];
    batch.forEach(r=>{
      const num=cleanTrk(r.trk);
      const contNum=r.cont?extractContainerNum(r.cont):null;
      if(isContainerNum(num)||(isSea(r)&&contNum)){
        containerItems.push(r);
      }else{
        regularNums.push(r);
      }
    });
    // Batch track regular numbers via Parcels API
    if(regularNums.length>0){
      try{
        // Build shipment objects with country (destination) from loc field
        const ids=regularNums.map(r=>{
          const obj={trackingId:cleanTrk(r.trk),country:'DE'};
          const oc=getOriginCountry(r.loc);if(oc)obj.origin=oc;
          // GLS requires postal code
          if(isGLS(r.mode,r.trk))obj.zipCode=DEFAULT_DEST_ZIP;
          return obj;
        });
        const result=await apiCallParcels(ids);
        if(result&&result.shipments){
          const cache=JSON.parse(localStorage.getItem('TRACK_CACHE')||'{}');
          result.shipments.forEach(ship=>{
            const tId=ship.trackingId;
            if(tId&&hasTrackingData(ship)){
              saveTrackResult(tId,ship,cache);tracked++;
              // Update UI for this row
              const row=regularNums.find(r=>cleanTrk(r.trk)===tId);
              if(row){const idx=allTransit.indexOf(row);const el=document.getElementById('trkRes'+idx);
                if(el){el.style.display='block';el.innerHTML=fmtTrk(ship)+buildManualSavePanel(tId,idx,row.mode,row.cont)}}
            }
          });
        }
      }catch(e){console.warn('Batch Parcels API failed:',e.message);
        // Fallback: track individually
        for(const r of regularNums){
          const idx=allTransit.indexOf(r);
          await trackOne(r.trk,r.mode,idx,r.cont);tracked++;
          await new Promise(r=>setTimeout(r,300));
        }
      }
    }
    // Track containers individually (need carrier popup handling)
    for(const r of containerItems){
      const idx=allTransit.indexOf(r);
      await trackOne(r.trk,r.mode,idx,r.cont);tracked++;
    }
    if(b+batchSize<stale.length)await new Promise(r=>setTimeout(r,500));
  }
  st.innerHTML='<span style="color:var(--gn)">\u2705 Tracked '+stale.length+' '+(filter==='all'?'':filter)+' shipments!'+(skipped?' ('+skipped+' skipped \u2014 tracked <3h ago)':'')+'</span>';
  renderInTransit();
}

// ============ LOAD DATA (FIREBASE) ============
function loadData(){
  try{
    fbDB.ref('shipments').on('value',(snap)=>{
      const d=snap.val();
      if(d){RAW=Array.isArray(d)?d:Object.values(d);handleLoaded()}
      else{fallbackLS()}
    },(err)=>{console.error('Firebase:',err);fallbackLS()});
  }catch(e){console.error(e);fallbackLS()}
}
function fallbackLS(){
  const d=localStorage.getItem('SHIP_DATA');
  if(d){try{RAW=JSON.parse(d);handleLoaded()}catch(e){showEmpty()}}
  else showEmpty();
}
function handleLoaded(){
  // Normalize ALL numeric fields — handles currency symbols, European format, formula strings
  RAW.forEach(r=>{
    // Normalize individual value fields first
    ['val','frt','vat','tpf','cduty','cfrt','vat2'].forEach(k=>{
      if(r[k]!==undefined&&r[k]!==null&&r[k]!==''){
        const pv=parseVal(r[k]);
        if(pv>0)r[k]=String(pv);
      }
    });
    // Normalize qty
    if(r.qty){const q=parseVal(r.qty);if(q>0)r.qty=String(Math.round(q))}
    // Fix tval — if it's a formula, zero, empty, or unparseable, compute from val+frt+vat+tpf
    // Fix tval — recompute from components and cross-check
    const tv=parseVal(r.tval);
    const computedTval=parseVal(r.val)+parseVal(r.frt)+parseVal(r.vat)+parseVal(r.tpf);
    if(tv<=0||String(r.tval||'').startsWith('=')){
      // tval missing/zero/formula — use computed sum or fallback to val
      if(computedTval>0)r.tval=String(Math.round(computedTval*100)/100);
      else{
        const justVal=parseVal(r.val);
        if(justVal>0)r.tval=String(justVal);
      }
    }else if(computedTval>0&&Math.abs(computedTval-tv)>1){
      // tval exists but significantly different from sum of components — fix it
      r.tval=String(Math.round(computedTval*100)/100);
    }else{
      r.tval=String(tv); // Normalize the stored format
    }
  });
  if(!initialized){loadTrackedETAs();reExtractCachedETAs();populateFilters();setDefaults();initialized=true}
  af();document.getElementById('loader').style.display='none';
}
function showEmpty(){
  document.getElementById('loader').innerHTML='<div class="empty-state"><div class="icon">&#x1F4E6;</div><h3>No Data Found</h3><p>Open <a href="data_entry.html">Data Entry</a> first to seed data into Firebase.</p></div>';
}

// ============ FILTERS ============
function populateFilters(){
  const sets={fy:new Set(),cat:new Set(),loc:new Set(),mode:new Set(),fsts:new Set(),vnd:new Set(),cont:new Set(),month:new Set(),qtr:new Set()};
  RAW.forEach(r=>{
    if(r.fy)sets.fy.add(r.fy);if(r.cat)sets.cat.add(r.cat);if(r.loc)sets.loc.add(r.loc);
    if(r.mode)sets.mode.add(r.mode);if(r.fsts)sets.fsts.add(r.fsts);if(r.vnd)sets.vnd.add(r.vnd);
    if(r.cont)sets.cont.add(r.cont);
    if(r.dt&&r.dt.length>=7){
      sets.month.add(r.dt.substring(0,7));
      const[y,m]=r.dt.substring(0,7).split('-').map(Number);
      sets.qtr.add(y+'Q'+Math.ceil(m/3));
    }
  });
  fillSel('fFY',sets.fy);fillSel('fCat',sets.cat);fillSel('fLoc',sets.loc);
  fillSel('fMode',sets.mode);fillSel('fSts',sets.fsts);fillSel('fVnd',sets.vnd);fillSel('fCont',sets.cont);
  // Quarters
  const qEl=document.getElementById('fQtr');
  [...sets.qtr].sort().reverse().forEach(q=>{const o=document.createElement('option');o.value=q;o.textContent=q;qEl.appendChild(o)});
  // Months
  const el=document.getElementById('fMonth');
  [...sets.month].sort().reverse().forEach(m=>{const o=document.createElement('option');o.value=m;const[y,mo]=m.split('-');o.textContent=MNAMES[parseInt(mo)-1]+' '+y;el.appendChild(o)});
}
function fillSel(id,s){const el=document.getElementById(id);[...s].filter(Boolean).sort().forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;el.appendChild(o)})}
function setDefaults(){
  const now=new Date(),y=now.getFullYear(),m=now.getMonth()+1;
  // Default: current Financial Year only (Apr-Mar). No month filter.
  const fyStart=m>=4?y:y-1,currentFY=fyStart+'-'+(fyStart+1);
  const fyEl=document.getElementById('fFY');
  for(let i=0;i<fyEl.options.length;i++){if(fyEl.options[i].value===currentFY){fyEl.value=currentFY;break}}
  // If current FY not found, try previous FY
  if(!fyEl.value){const prevFY=(fyStart-1)+'-'+fyStart;for(let i=0;i<fyEl.options.length;i++){if(fyEl.options[i].value===prevFY){fyEl.value=prevFY;break}}}
}
function af(){
  const fy=document.getElementById('fFY').value,qtr=document.getElementById('fQtr').value,month=document.getElementById('fMonth').value;
  const cat=document.getElementById('fCat').value,loc=document.getElementById('fLoc').value;
  const mode=document.getElementById('fMode').value,sts=document.getElementById('fSts').value;
  const vnd=document.getElementById('fVnd').value,cont=document.getElementById('fCont').value;
  FD=RAW.filter(r=>{
    if(fy&&r.fy!==fy)return false;
    if(qtr&&r.dt&&r.dt.length>=7){const[y,m]=r.dt.substring(0,7).split('-').map(Number);const rq=y+'Q'+Math.ceil(m/3);if(rq!==qtr)return false}
    else if(qtr&&!r.dt)return false;
    if(month&&(!r.dt||r.dt.substring(0,7)!==month))return false;
    if(cat&&r.cat!==cat)return false;if(loc&&r.loc!==loc)return false;
    if(mode&&r.mode!==mode)return false;if(sts&&r.fsts!==sts)return false;
    if(vnd&&r.vnd!==vnd)return false;if(cont&&r.cont!==cont)return false;
    if(QF>0&&r.dt){const now=new Date(),cutoff=new Date(now.getFullYear(),now.getMonth()-QF+1,1);if(new Date(r.dt)<cutoff)return false}
    return true;
  });
  tblPage=0;renderAll();
}
function resetF(){['fFY','fQtr','fMonth','fCat','fLoc','fMode','fSts','fVnd','fCont'].forEach(id=>document.getElementById(id).value='');QF=0;updQF();af()}


// ============ RENDER ALL ============
function renderAll(){renderInTransit();renderDelivered();renderBottlenecks();renderOverall();renderTrendTab();renderTbl()}

// ============ CHART HELPER (SINGLE Y) ============
function mkC(id,type,labels,datasets,leg){
  if(charts[id]){charts[id].destroy();delete charts[id]}
  const ctx=document.getElementById(id);if(!ctx)return;
  const isDoughnut=type==='doughnut'||type==='pie';
  charts[id]=new Chart(ctx,{type,data:{labels,datasets},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:!!leg,position:'top',labels:{color:'#94a3b8',boxWidth:10,padding:6,font:{size:10}}}},scales:isDoughnut?{}:{x:{ticks:{color:'#64748b',font:{size:9},maxRotation:45},grid:{color:'rgba(51,65,85,.3)'}},y:{ticks:{color:'#64748b',font:{size:9}},grid:{color:'rgba(51,65,85,.3)'},beginAtZero:true}}}});
}

// ============ CHART HELPER (DUAL Y AXIS) ============
function mkC2(id,type,labels,datasets,opts){
  if(charts[id]){charts[id].destroy();delete charts[id]}
  const ctx=document.getElementById(id);if(!ctx)return;
  charts[id]=new Chart(ctx,{type,data:{labels,datasets},options:Object.assign({responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{display:true,position:'top',labels:{color:'#94a3b8',boxWidth:10,padding:6,font:{size:10}}}}},opts||{})});
}

// ============ DETAIL PANEL ============
function showDetailPanel(title,shipments){
  const panel=document.getElementById('detailPanel'),overlay=document.getElementById('dpOverlay');
  if(!panel)return;
  document.getElementById('dpTitle').textContent=title;
  const body=document.getElementById('dpBody');
  const tv=shipments.reduce((s,r)=>s+(parseVal(r.tval)),0);
  const tq=shipments.reduce((s,r)=>s+(parseVal(r.qty)),0);
  const conts=new Set(shipments.map(r=>r.cont).filter(Boolean)).size;
  const air=shipments.filter(r=>isAir(r)).length,sea=shipments.filter(r=>isSea(r)).length;
  const jp=shipments.filter(r=>{const c=(r.cat||'').toUpperCase();return c==='JP'||c.includes('JP SAMPLE')}).length;
  let h='<div class="dp-kpi">';
  h+=`<div class="dp-k"><span class="dp-kv" style="color:#fbbf24">${shipments.length}</span><span class="dp-kl">Shipments</span></div>`;
  h+=`<div class="dp-k"><span class="dp-kv" style="color:#f472b6">${conts}</span><span class="dp-kl">Containers</span></div>`;
  h+=`<div class="dp-k"><span class="dp-kv" style="color:#34d399">${fc(tv)}</span><span class="dp-kl">Value</span></div>`;
  h+=`<div class="dp-k"><span class="dp-kv" style="color:#a78bfa">${tq.toLocaleString()}</span><span class="dp-kl">Pieces</span></div>`;
  h+=`<div class="dp-k"><span class="dp-kv" style="color:#60a5fa">${air}</span><span class="dp-kl">Air</span></div>`;
  h+=`<div class="dp-k"><span class="dp-kv" style="color:#06b6d4">${sea}</span><span class="dp-kl">Sea</span></div>`;
  h+=`<div class="dp-k"><span class="dp-kv" style="color:#818cf8">${jp}</span><span class="dp-kl">JP</span></div>`;
  h+=`<div class="dp-k"><span class="dp-kv" style="color:#c084fc">${shipments.length-jp}</span><span class="dp-kl">NJP</span></div></div>`;
  // Breakdown by vendor
  const vndMap={};shipments.forEach(r=>{const v=r.vnd||'Unknown';if(!vndMap[v])vndMap[v]={count:0,val:0};vndMap[v].count++;vndMap[v].val+=(parseVal(r.tval))});
  const vndArr=Object.entries(vndMap).sort((a,b)=>b[1].val-a[1].val);
  if(vndArr.length>1){
    h+='<div class="dp-breakdown"><div class="dp-break-title">By Vendor</div><div class="dp-break-list">';
    vndArr.slice(0,8).forEach(([v,d])=>{h+=`<div class="dp-break-row"><span>${v}</span><span>${d.count} shipments \u00B7 ${fc(d.val)}</span></div>`});
    h+='</div></div>';
  }
  // Breakdown by mode
  const modeMap={};shipments.forEach(r=>{const m=r.mode||'Unknown';if(!modeMap[m])modeMap[m]={count:0,val:0};modeMap[m].count++;modeMap[m].val+=(parseVal(r.tval))});
  const modeArr=Object.entries(modeMap).sort((a,b)=>b[1].count-a[1].count);
  if(modeArr.length>1){
    h+='<div class="dp-breakdown"><div class="dp-break-title">By Mode</div><div class="dp-break-list">';
    modeArr.forEach(([m,d])=>{h+=`<div class="dp-break-row"><span>${m}</span><span>${d.count} shipments \u00B7 ${fc(d.val)}</span></div>`});
    h+='</div></div>';
  }
  // Full table
  h+='<div class="dp-tbl-wrap"><table><thead><tr><th>Invoice</th><th>Date</th><th>Mode</th><th>Category</th><th>Container</th><th>Tracking</th><th>SKU</th><th>Qty</th><th>Value</th><th>Vendor</th><th>ETA</th><th>Status</th></tr></thead><tbody>';
  // Sort detail panel by ETA ascending (soonest first), no ETA at bottom
  shipments.sort((a,b)=>{
    const ea=getEffectiveETA(a), eb=getEffectiveETA(b);
    if(!ea&&!eb)return 0;if(!ea)return 1;if(!eb)return -1;
    return ea.localeCompare(eb);
  });
  shipments.forEach(r=>{
    const effEta=getEffectiveETA(r)||r.eta;
    h+=`<tr><td>${r.inv||'-'}</td><td>${r.dt||'-'}</td><td>${r.mode||'-'}</td><td><span class="k-badge ${catBadgeCls(r.cat)}">${r.cat||'-'}</span></td><td style="color:#f472b6;font-size:10px">${r.cont||'-'}</td><td>${r.trk?'<a href="'+trkUrl(r.trk,r.mode)+'" target="_blank" style="color:var(--ac);text-decoration:none">'+r.trk+'</a>':'-'}</td><td>${r.sku||'-'}</td><td>${r.qty||'-'}</td><td>${fcFull(parseVal(r.tval))}</td><td>${r.vnd||'-'}</td><td>${effEta||'-'}</td><td>${r.fsts||r.sts||'-'}</td></tr>`;
  });
  h+='</tbody></table></div>';
  body.innerHTML=h;
  panel.classList.add('open');overlay.classList.add('open');
  document.body.style.overflow='hidden';
}
function closeDetailPanel(){
  const p=document.getElementById('detailPanel'),o=document.getElementById('dpOverlay');
  if(p)p.classList.remove('open');if(o)o.classList.remove('open');
  document.body.style.overflow='';
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDetailPanel()});
function showKpiDetail(title,filterFn){
  const shipments=FD.filter(filterFn);
  if(shipments.length)showDetailPanel(title,shipments);
}
function showShipmentCard(idx){
  const r=KANBAN_ITEMS[idx];if(!r)return;
  const panel=document.getElementById('detailPanel'),overlay=document.getElementById('dpOverlay');
  if(!panel)return;
  document.getElementById('dpTitle').textContent=r.inv||r.trk||'Shipment Detail';
  const body=document.getElementById('dpBody');
  const ct=cleanTrk(r.trk);
  const contNum3=r.cont?extractContainerNum(r.cont):null;
  const effEta=r.aeta||(ct&&TRACKED_ETA[ct]?TRACKED_ETA[ct]:(contNum3&&TRACKED_ETA[contNum3]?TRACKED_ETA[contNum3]:r.eta))||r.eta;
  const trkSts=(ct&&TRACKED_STS[ct])?TRACKED_STS[ct]:(contNum3?TRACKED_STS[contNum3]:null);
  const lastTrk=(ct&&TRACKED_TS[ct])?TRACKED_TS[ct]:(contNum3?TRACKED_TS[contNum3]:null);
  const dl=effEta?daysUntil(effEta):null;
  const dlText=dl!==null?(dl<0?Math.abs(dl)+' days late':dl===0?'Arriving Today':dl+' days left'):'-';
  const dlColor=dl!==null?(dl<0?'#f87171':dl===0?'#22d3ee':dl<=3?'#fbbf24':'#34d399'):'#94a3b8';
  // Shipment info cards
  let h='<div class="dp-kpi" style="grid-template-columns:repeat(3,1fr)">';
  h+=`<div class="dp-k"><span class="dp-kv" style="color:#34d399">${fcFull(parseVal(r.tval))}</span><span class="dp-kl">Value</span></div>`;
  h+=`<div class="dp-k"><span class="dp-kv" style="color:#a78bfa">${r.qty||'-'}</span><span class="dp-kl">Quantity</span></div>`;
  h+=`<div class="dp-k"><span class="dp-kv" style="color:${dlColor}">${dlText}</span><span class="dp-kl">ETA Status</span></div>`;
  h+='</div>';
  // Shipment details grid
  h+='<div class="dp-breakdown"><div class="dp-break-title">Shipment Details</div><div class="dp-break-list">';
  h+=`<div class="dp-break-row"><span>Invoice</span><span>${r.inv||'-'}</span></div>`;
  h+=`<div class="dp-break-row"><span>Date</span><span>${r.dt||'-'}</span></div>`;
  h+=`<div class="dp-break-row"><span>Mode</span><span>${r.mode||'-'}</span></div>`;
  h+=`<div class="dp-break-row"><span>Category</span><span>${r.cat||'-'}</span></div>`;
  h+=`<div class="dp-break-row"><span>Container</span><span style="color:#f472b6">${r.cont||'-'}</span></div>`;
  h+=`<div class="dp-break-row"><span>SKU</span><span>${r.sku||'-'}</span></div>`;
  h+=`<div class="dp-break-row"><span>Vendor</span><span>${r.vnd||'-'}</span></div>`;
  h+=`<div class="dp-break-row"><span>Location</span><span>${r.loc||'-'}</span></div>`;
  h+=`<div class="dp-break-row"><span>Agent</span><span>${r.agt||'-'}</span></div>`;
  h+=`<div class="dp-break-row"><span>PO</span><span>${r.po||'-'}</span></div>`;
  h+=`<div class="dp-break-row"><span>Original ETA</span><span>${r.eta||'-'}</span></div>`;
  h+=`<div class="dp-break-row"><span>Effective ETA</span><span style="color:#22d3ee">${effEta||'-'}${ct&&TRACKED_ETA[ct]?' \u{1F4E1} API':''}${r.aeta?' (Actual)':''}</span></div>`;
  h+=`<div class="dp-break-row"><span>Freight Value</span><span>${fcFull(parseFloat(r.frt)||0)}</span></div>`;
  // Show API status if available, otherwise file status
  const apiStsForPanel=trkSts||null;
  const fileSts=r.fsts||r.sts||'-';
  if(apiStsForPanel&&apiStsForPanel.toLowerCase()!==fileSts.toLowerCase()){
    const apiStsColor=apiStsForPanel.toLowerCase().includes('deliver')?'#10b981':apiStsForPanel.toLowerCase().includes('transit')?'#22d3ee':'var(--ac)';
    h+=`<div class="dp-break-row"><span>Status</span><span><span style="color:${apiStsColor};font-weight:700">${apiStsForPanel}</span> <span style="font-size:10px;color:var(--t2)">(File: ${fileSts})</span></span></div>`;
  }else{
    h+=`<div class="dp-break-row"><span>Status</span><span>${fileSts}</span></div>`;
  }
  if(r.rmk)h+=`<div class="dp-break-row"><span>Remarks</span><span>${r.rmk}</span></div>`;
  h+='</div></div>';
  // Tracking section
  h+='<div class="dp-breakdown"><div class="dp-break-title">\u{1F4E1} Tracking Information</div>';
  if(r.trk){
    h+=`<div style="margin-bottom:10px"><a href="${trkUrl(r.trk,r.mode)}" target="_blank" style="color:var(--ac);text-decoration:none;font-weight:700;font-size:14px">${r.trk} \u2197</a></div>`;
    if(trkSts){const sColor=trkSts.toLowerCase().includes('deliver')?'#10b981':trkSts.toLowerCase().includes('exception')?'var(--rd)':'var(--ac)';h+=`<div style="margin-bottom:8px;font-size:14px"><span style="font-weight:700;color:${sColor}">Status:</span> <span style="color:${sColor};font-weight:600">${trkSts}</span></div>`;}
    if(lastTrk)h+=`<div style="margin-bottom:10px;font-size:12px;color:var(--t2)">Last tracked: ${fmtTrackTime(lastTrk)} (${timeAgo(lastTrk)})</div>`;
    // Pull full tracking events from TRACK_CACHE (try tracking#, container#, and raw trk)
    let trackingHtml='';
    try{
      const cache=JSON.parse(localStorage.getItem('TRACK_CACHE')||'{}');
      const contNum2=r.cont?extractContainerNum(r.cont):null;
      const cached=cache[ct]||cache[contNum2]||cache[r.trk];
      if(cached&&cached.data){
        trackingHtml=fmtTrk(cached.data);
      }
    }catch(e){}
    if(trackingHtml){
      h+=`<div style="background:var(--bg);border-radius:10px;padding:16px;border:1px solid var(--c2)">${trackingHtml}</div>`;
    }else if(trkSts){
      h+=`<div style="background:var(--bg);border-radius:10px;padding:16px;border:1px solid var(--c2);color:var(--t2);font-size:13px">Status: ${trkSts}<br><br>Full event history not cached. Click <strong>"Track"</strong> in the In-Transit table to fetch latest events.</div>`;
    }else{
      h+=`<div style="background:var(--bg);border-radius:10px;padding:16px;border:1px solid var(--c2);color:var(--t2);font-size:13px">\u23F3 Not yet tracked.<br><br>Use the <strong>Track</strong> button in the In-Transit table to fetch tracking events.</div>`;
    }
    h+=`<div style="margin-top:12px">${buildCarrierLinks(r.trk,r.mode,r.cont)}</div>`;
  }else{
    h+='<div style="color:var(--t2);font-size:13px;padding:8px 0">No tracking number available for this shipment.</div>';
  }
  h+='</div>';
  // Container info if available
  if(r.cont){
    const sameContainer=FD.filter(x=>x.cont===r.cont);
    if(sameContainer.length>1){
      h+='<div class="dp-breakdown"><div class="dp-break-title">\u{1F4E6} Same Container ('+r.cont+')</div><div class="dp-break-list">';
      sameContainer.forEach(x=>{
        if(x.inv===r.inv&&x.trk===r.trk)return;
        h+=`<div class="dp-break-row"><span>${x.inv||x.trk||'-'} &middot; ${x.cat||'-'}</span><span>${fcFull(parseFloat(x.tval)||0)} &middot; ${x.qty||'-'} pcs</span></div>`;
      });
      h+='</div></div>';
    }
  }
  body.innerHTML=h;
  panel.classList.add('open');overlay.classList.add('open');
  document.body.style.overflow='hidden';
}

// ============ TAB 0: IN-TRANSIT COMMAND CENTER ============
function renderInTransit(){
  const allTr=FD.filter(r=>isTrans(r));
  // Separate API-delivered from active in-transit
  const deliveredTr=allTr.filter(r=>isApiDelivered(r));
  const tr=allTr.filter(r=>!isApiDelivered(r));
  const box=document.getElementById('transitTblWrap'),empty=document.getElementById('transitEmpty');
  const kpi=document.getElementById('transitKpi'),timeline=document.getElementById('etaTimeline');
  if(!tr.length&&!deliveredTr.length){if(box)box.style.display='none';if(empty)empty.style.display='block';if(kpi)kpi.innerHTML='';if(timeline)timeline.innerHTML='';return}
  if(box)box.style.display='block';if(empty)empty.style.display='none';
  const now=new Date(),od=tr.filter(r=>{const e=getEffectiveETA(r);return e&&new Date(e)<now});
  const seaTr=tr.filter(r=>isSea(r)),airTr=tr.filter(r=>isAir(r));
  const upcoming=tr.filter(r=>{const e=getEffectiveETA(r);return e&&new Date(e)>=now}).sort((a,b)=>new Date(getEffectiveETA(a))-new Date(getEffectiveETA(b)));
  const nextEta=upcoming.length?daysUntil(getEffectiveETA(upcoming[0])):'-';
  const tVal=tr.reduce((s,r)=>s+(parseVal(r.tval)),0);
  const tQty=tr.reduce((s,r)=>s+(parseVal(r.qty)),0);
  const contInTransit=new Set(tr.map(r=>r.cont).filter(Boolean)).size;
  const vqVal=VMODE==='qty'?tQty.toLocaleString()+' pcs':fc(tVal);
  if(kpi)kpi.innerHTML=
    `<div class="ts-card clickable" onclick="showDetailPanel('All In-Transit Shipments',FD.filter(r=>isTrans(r)&&!isApiDelivered(r)))"><div class="num" style="color:#fbbf24">${tr.length}</div><div class="lbl">In Transit</div><div class="click-hint">Click to view</div></div>`+
    `<div class="ts-card clickable" onclick="showDetailPanel('Overdue Shipments',FD.filter(r=>{if(!isTrans(r)||isApiDelivered(r))return false;const e=getEffectiveETA(r);return e&&new Date(e)<new Date()}))"><div class="num" style="color:#f87171">${od.length}</div><div class="lbl">Overdue</div><div class="click-hint">Click to view</div></div>`+
    `<div class="ts-card clickable" onclick="showDetailPanel('Air Shipments (In-Transit)',FD.filter(r=>isTrans(r)&&!isApiDelivered(r)&&isAir(r)))"><div class="num" style="color:#60a5fa">${airTr.length}</div><div class="lbl">Air</div><div class="click-hint">Click to view</div></div>`+
    `<div class="ts-card clickable" onclick="showDetailPanel('Sea Shipments (In-Transit)',FD.filter(r=>isTrans(r)&&!isApiDelivered(r)&&isSea(r)))"><div class="num" style="color:#34d399">${seaTr.length}</div><div class="lbl">Sea</div><div class="click-hint">Click to view</div></div>`+
    `<div class="ts-card"><div class="num" style="color:#22d3ee">${nextEta}</div><div class="lbl">Days to Next</div></div>`+
    `<div class="ts-card"><div class="num" style="color:#a78bfa">${vqVal}</div><div class="lbl">${VMODE==='qty'?'Quantity':'Value'}</div></div>`+
    `<div class="ts-card clickable" onclick="showDetailPanel('In-Transit Containers',FD.filter(r=>isTrans(r)&&!isApiDelivered(r)&&r.cont))"><div class="num" style="color:#f472b6">${contInTransit}</div><div class="lbl">Containers</div><div class="click-hint">Click to view</div></div>`+
    (deliveredTr.length?`<div class="ts-card clickable" onclick="document.getElementById('deliveredRef')?.scrollIntoView({behavior:'smooth'})"><div class="num" style="color:#10b981">${deliveredTr.length}</div><div class="lbl">\u2705 Delivered</div><div class="click-hint">View below</div></div>`:'');

  // KANBAN
  const todayStr=now.toISOString().substring(0,10);
  const oneDay=86400000,endOfWeek=new Date(now.getTime()+(7-now.getDay())*oneDay),endOfNextWeek=new Date(endOfWeek.getTime()+7*oneDay);
  const endOfWeekStr=endOfWeek.toISOString().substring(0,10),endOfNextWeekStr=endOfNextWeek.toISOString().substring(0,10);
  const groups={overdue:[],today:[],thisWeek:[],nextWeek:[],later:[],noEta:[]};
  tr.forEach(r=>{
    const effEta=getEffectiveETA(r);
    if(!effEta){groups.noEta.push(r);return}
    const etaDate=effEta.substring(0,10);
    if(etaDate<todayStr)groups.overdue.push(r);
    else if(etaDate===todayStr)groups.today.push(r);
    else if(etaDate<=endOfWeekStr)groups.thisWeek.push(r);
    else if(etaDate<=endOfNextWeekStr)groups.nextWeek.push(r);
    else groups.later.push(r);
  });
  const cols=[
    {lbl:'\u{1F6A8} Overdue',cls:'kanban-overdue',items:groups.overdue},
    {lbl:'\u{1F4CC} Today',cls:'kanban-today',items:groups.today},
    {lbl:'\u{1F4C5} This Week',cls:'kanban-thisweek',items:groups.thisWeek},
    {lbl:'\u27A1 Next Week',cls:'kanban-nextweek',items:groups.nextWeek},
    {lbl:'\u{1F4C6} Later',cls:'kanban-later',items:groups.later},
    {lbl:'\u2753 No ETA',cls:'kanban-noeta',items:groups.noEta}];
  KANBAN_COLS=cols;
  KANBAN_ITEMS=[];
  let h='';
  cols.forEach((g,ci)=>{
    h+=`<div class="kanban-col ${g.cls}"><div class="kanban-hdr clickable" onclick="showDetailPanel('${g.lbl.replace(/'/g,"\\'")} ('+KANBAN_COLS[${ci}].items.length+')',KANBAN_COLS[${ci}].items)">${g.lbl}<span class="cnt">${g.items.length}</span><div class="click-hint">Click to expand</div></div><div class="kanban-body">`;
    g.items.forEach(r=>{
      const ki=KANBAN_ITEMS.length;KANBAN_ITEMS.push(r);
      const effEta=getEffectiveETA(r);const tracked=isTrackedETA(r);
      const ct=cleanTrk(r.trk);const trkSts=ct?TRACKED_STS[ct]:null;
      const dl=effEta?daysUntil(effEta):null,dlText=dl!==null?(dl<0?Math.abs(dl)+'d late':dl===0?'Today':dl+'d left'):'-';
      const dlColor=dl!==null?(dl<0?'#f87171':dl===0?'#22d3ee':dl<=3?'#fbbf24':'#34d399'):'#94a3b8';
      const etaSrc=tracked?'<span style="color:#22d3ee;font-size:8px" title="ETA from courier">\u{1F4E1}</span> ':'<span style="color:#64748b;font-size:8px" title="ETA from database">\u{1F4CB}</span> ';
      const plannedVsApi=(tracked&&r.eta&&effEta!==r.eta)?`<div style="font-size:7px;color:var(--t2);text-align:right">Plan: ${r.eta}</div>`:'';
      const lastTrk=ct?TRACKED_TS[ct]:null;const trkAge=timeAgo(lastTrk);
      const trkLine=r.trk?(lastTrk?`<div style="text-align:right;font-size:8px;margin-top:1px;color:${(Date.now()-lastTrk)<14400000?'#22d3ee':'#f59e0b'}">\u{1F4E1} ${trkAge}</div>`:`<div style="text-align:right;font-size:8px;color:#64748b;margin-top:1px">\u23F3 Not tracked</div>`):'';
      const contLine=r.cont?`<div class="k-meta"><span style="color:#f472b6;font-size:8px" title="Container">\u{1F4E6} ${r.cont.length>16?r.cont.substring(0,14)+'..':r.cont}</span></div>`:'';
      const hasCache=ct&&(function(){try{const c=JSON.parse(localStorage.getItem('TRACK_CACHE')||'{}');return!!(c[ct]&&c[ct].data)}catch(e){return false}})();
      const trkIcon=hasCache?'<div style="font-size:7px;color:#22d3ee;text-align:right;margin-top:1px">\u{1F50D} Click for tracking</div>':'';
      h+=`<div class="k-card clickable" onclick="showShipmentCard(${ki})" style="cursor:pointer;${lastTrk&&(Date.now()-lastTrk)<14400000?'border-left:2px solid #22d3ee':''}"><div style="display:flex;justify-content:space-between;align-items:start"><span class="k-inv">${r.inv||r.trk||'N/A'}</span><span class="k-badge ${catBadgeCls(r.cat)}">${r.cat||'-'}</span></div><div class="k-meta"><span>${r.mode||'-'}</span><span>${r.vnd?(r.vnd.length>12?r.vnd.substring(0,10)+'..':r.vnd):'-'}</span></div>${contLine}<div class="k-meta"><span style="color:#34d399;font-weight:600">${fcFull(parseVal(r.tval))}</span>${trkSts?'<span style="color:#22d3ee;font-size:9px;font-weight:600">\u{1F4E1} '+trkSts+'</span>':'<span>'+(r.dt||'-')+'</span>'}</div><div class="k-meta"><span>${etaSrc}${effEta||'No ETA'}</span><span class="k-days" style="color:${dlColor}">${dlText}</span></div>${plannedVsApi}${trkLine}${trkIcon}</div>`;
    });
    h+='</div></div>';
  });
  if(timeline)timeline.innerHTML=h;

  // WEEKLY + MONTHLY PLANNING VIEW (uses FD for expected vs delivered)
  const wpEl=document.getElementById('weeklyPlan');
  const isDlv=r=>{const s=(r.fsts||'').toLowerCase();return s.includes('received')||s.includes('delivered')||s.includes('ams')||!!r.aeta};
  if(wpEl){
    // Build 12 weeks data — ALL filtered shipments, not just in-transit
    PLANNER_WEEKS=[];const wkStart=new Date(now);wkStart.setDate(wkStart.getDate()-wkStart.getDay()+1);
    for(let w=0;w<12;w++){
      const ws=new Date(wkStart.getTime()+w*7*oneDay);
      const we=new Date(ws.getTime()+6*oneDay);
      const wsStr=ws.toISOString().substring(0,10),weStr=we.toISOString().substring(0,10);
      const wShip=FD.filter(r=>{const e=getEffectiveETA(r);if(!e)return false;const ed=e.substring(0,10);return ed>=wsStr&&ed<=weStr});
      const wDlv=wShip.filter(r=>isDlv(r)),wPend=wShip.filter(r=>!isDlv(r));
      const wCont=new Set(wShip.map(r=>r.cont).filter(Boolean)).size;
      const wVal=wShip.reduce((s,r)=>s+(parseVal(r.tval)),0);
      const wQty=wShip.reduce((s,r)=>s+(parseVal(r.qty)),0);
      const wAir=wShip.filter(r=>isAir(r)).length,wSea=wShip.filter(r=>isSea(r)).length;
      const wJP=wShip.filter(r=>{const c=(r.cat||'').toUpperCase();return c==='JP'||c.includes('JP SAMPLE')}).length;
      PLANNER_WEEKS.push({ws,we,shipments:wShip,ship:wShip.length,dlv:wDlv.length,pend:wPend.length,cont:wCont,val:wVal,qty:wQty,air:wAir,sea:wSea,jp:wJP,njp:wShip.length-wJP,isNow:w===0,label:ws.toLocaleDateString('en-GB',{day:'2-digit',month:'short'})+' \u2013 '+we.toLocaleDateString('en-GB',{day:'2-digit',month:'short'})});
    }
    // WEEKLY CARDS
    let wh='<div class="planner-grid">';
    PLANNER_WEEKS.forEach((w,i)=>{
      const dlvPct=w.ship>0?Math.round(w.dlv/w.ship*100):0;
      const barColor=w.ship===0?'var(--c2)':dlvPct===100?'rgba(16,185,129,.7)':dlvPct>=50?'rgba(59,130,246,.6)':dlvPct>0?'rgba(245,158,11,.6)':'rgba(239,68,68,.4)';
      wh+=`<div class="planner-card${w.isNow?' planner-now':''} clickable" onclick="showDetailPanel('Week ${i+1}: ${w.label}',PLANNER_WEEKS[${i}].shipments)" style="--bar-pct:${dlvPct}%;--bar-color:${barColor}">`;
      wh+=`<div class="planner-hdr">${w.isNow?'<span class="planner-badge">THIS WEEK</span>':'<span class="planner-wk">Week '+(i+1)+'</span>'}<span class="planner-date">${w.label}</span></div>`;
      wh+=`<div class="planner-bar" title="${w.dlv} of ${w.ship} delivered (${dlvPct}%)"><div class="planner-bar-fill"></div></div>`;
      wh+=`<div class="planner-progress"><span style="color:${dlvPct===100?'#10b981':dlvPct>=50?'#3b82f6':'#f59e0b'}">\u2705 ${w.dlv}</span><span style="color:var(--t2)">/</span><span>${w.ship}</span><span class="planner-pct" style="color:${dlvPct===100?'#10b981':dlvPct>=50?'#3b82f6':'#f59e0b'}">${dlvPct}%</span></div>`;
      wh+=`<div class="planner-sub" style="margin-bottom:4px">${w.pend>0?'<span style="color:#fbbf24">'+w.pend+' pending</span>':'<span style="color:#10b981">All delivered</span>'}</div>`;
      wh+=`<div class="planner-metrics">`;
      wh+=`<div class="planner-m"><span class="planner-m-val" style="color:#f472b6">${w.cont}</span><span class="planner-m-lbl">containers</span></div>`;
      wh+=`<div class="planner-m"><span class="planner-m-val" style="color:#34d399">${fc(w.val)}</span><span class="planner-m-lbl">value</span></div>`;
      wh+=`<div class="planner-m"><span class="planner-m-val" style="color:#a78bfa">${w.qty.toLocaleString()}</span><span class="planner-m-lbl">pcs</span></div>`;
      wh+=`</div>`;
      wh+=`<div class="planner-foot"><span>\u2708 ${w.air}</span><span>\u{1F6A2} ${w.sea}</span><span style="color:#60a5fa">JP ${w.jp}</span><span style="color:#a78bfa">NJP ${w.njp}</span></div>`;
      wh+=`<div class="click-hint" style="margin-top:6px">Click for details</div>`;
      wh+=`</div>`;
    });
    wh+='</div>';
    // WEEKLY TOTALS STRIP
    const totShip=PLANNER_WEEKS.reduce((s,w)=>s+w.ship,0),totDlv=PLANNER_WEEKS.reduce((s,w)=>s+w.dlv,0),totPend=PLANNER_WEEKS.reduce((s,w)=>s+w.pend,0);
    const totCont=PLANNER_WEEKS.reduce((s,w)=>s+w.cont,0);
    const totVal=PLANNER_WEEKS.reduce((s,w)=>s+w.val,0),totQty=PLANNER_WEEKS.reduce((s,w)=>s+w.qty,0);
    const totPct=totShip>0?Math.round(totDlv/totShip*100):0;
    wh+=`<div class="planner-totals"><div class="planner-t"><span class="planner-t-val" style="color:#fbbf24">${totShip}</span><span class="planner-t-lbl">Expected</span></div><div class="planner-t"><span class="planner-t-val" style="color:#10b981">${totDlv} <span style="font-size:12px">(${totPct}%)</span></span><span class="planner-t-lbl">Delivered</span></div><div class="planner-t"><span class="planner-t-val" style="color:#f59e0b">${totPend}</span><span class="planner-t-lbl">Pending</span></div><div class="planner-t"><span class="planner-t-val" style="color:#34d399">${fc(totVal)}</span><span class="planner-t-lbl">Total Value</span></div></div>`;
    // Wrap 12-Week section as collapsible
    const wkSummary=`<span class="cs-item"><span class="cs-val" style="color:#fbbf24">${totShip}</span> shipments</span><span class="cs-item"><span class="cs-val" style="color:#10b981">${totDlv}</span> delivered</span><span class="cs-item"><span class="cs-val" style="color:#f59e0b">${totPend}</span> pending</span>`;
    wh=makeCollapsible('12wk','<div class="sec-title" style="margin:0"><span class="dot" style="background:var(--cy)"></span> 12-Week Capacity Planner</div>',wh,wkSummary,false);

    // MONTHLY PROJECTION (next 12 months) — ALL filtered shipments
    PLANNER_MONTHS=[];
    for(let m=0;m<12;m++){
      const ms=new Date(now.getFullYear(),now.getMonth()+m,1);
      const me=new Date(now.getFullYear(),now.getMonth()+m+1,0);
      const msStr=ms.toISOString().substring(0,10),meStr=me.toISOString().substring(0,10);
      const mShip=FD.filter(r=>{const e=getEffectiveETA(r);if(!e)return false;const ed=e.substring(0,10);return ed>=msStr&&ed<=meStr});
      const mDlv=mShip.filter(r=>isDlv(r)),mPend=mShip.filter(r=>!isDlv(r));
      const mCont=new Set(mShip.map(r=>r.cont).filter(Boolean)).size;
      const mVal=mShip.reduce((s,r)=>s+(parseVal(r.tval)),0);
      const mQty=mShip.reduce((s,r)=>s+(parseVal(r.qty)),0);
      const mAir=mShip.filter(r=>isAir(r)).length,mSea=mShip.filter(r=>isSea(r)).length;
      const mJP=mShip.filter(r=>{const c=(r.cat||'').toUpperCase();return c==='JP'||c.includes('JP SAMPLE')}).length;
      const mLabel=ms.toLocaleDateString('en-GB',{month:'long',year:'numeric'});
      PLANNER_MONTHS.push({ms,shipments:mShip,ship:mShip.length,dlv:mDlv.length,pend:mPend.length,cont:mCont,val:mVal,qty:mQty,air:mAir,sea:mSea,jp:mJP,njp:mShip.length-mJP,isNow:m===0,label:mLabel});
    }
    let moContent='<div class="planner-month-grid">';
    PLANNER_MONTHS.forEach((m,i)=>{
      const dlvPct=m.ship>0?Math.round(m.dlv/m.ship*100):0;
      const barColor=m.ship===0?'var(--c2)':dlvPct===100?'rgba(16,185,129,.7)':dlvPct>=50?'rgba(59,130,246,.6)':dlvPct>0?'rgba(245,158,11,.6)':'rgba(239,68,68,.4)';
      moContent+=`<div class="planner-month-card${m.isNow?' planner-now':''} clickable" onclick="showDetailPanel('${m.label}',PLANNER_MONTHS[${i}].shipments)">`;
      moContent+=`<div class="planner-month-hdr">${m.isNow?'<span class="planner-badge">CURRENT</span>':''}${m.label}</div>`;
      moContent+=`<div class="planner-bar" style="--bar-pct:${dlvPct}%;--bar-color:${barColor};margin:8px 0" title="${m.dlv} of ${m.ship} delivered (${dlvPct}%)"><div class="planner-bar-fill"></div></div>`;
      moContent+=`<div class="planner-month-body">`;
      moContent+=`<div class="planner-month-big"><span style="font-size:28px;font-weight:800;color:${m.ship>0?'#fbbf24':'var(--t2)'}">${m.ship}</span><span style="font-size:10px;color:var(--t2)"> expected</span></div>`;
      moContent+=`<div class="planner-month-row"><span style="color:#10b981">\u2705 ${m.dlv} delivered (${dlvPct}%)</span><span style="color:#f59e0b">\u23F3 ${m.pend} pending</span></div>`;
      moContent+=`<div class="planner-month-row"><span style="color:#f472b6">\u{1F4E6} ${m.cont} containers</span><span style="color:#34d399">\u{1F4B0} ${fc(m.val)}</span></div>`;
      moContent+=`<div class="planner-month-row"><span style="color:#a78bfa">${m.qty.toLocaleString()} pcs</span><span>\u2708 ${m.air} \u{1F6A2} ${m.sea}</span></div>`;
      moContent+=`<div class="planner-month-row"><span style="color:#60a5fa">JP: ${m.jp}</span><span style="color:#c084fc">NJP: ${m.njp}</span></div>`;
      moContent+=`<div class="click-hint" style="margin-top:6px">Click for details</div>`;
      moContent+=`</div></div>`;
    });
    moContent+='</div>';
    // MONTHLY TOTALS
    const mTotShip=PLANNER_MONTHS.reduce((s,m)=>s+m.ship,0),mTotDlv=PLANNER_MONTHS.reduce((s,m)=>s+m.dlv,0),mTotPend=PLANNER_MONTHS.reduce((s,m)=>s+m.pend,0);
    const mTotCont=PLANNER_MONTHS.reduce((s,m)=>s+m.cont,0);
    const mTotVal=PLANNER_MONTHS.reduce((s,m)=>s+m.val,0),mTotQty=PLANNER_MONTHS.reduce((s,m)=>s+m.qty,0);
    const mTotPct=mTotShip>0?Math.round(mTotDlv/mTotShip*100):0;
    moContent+=`<div class="planner-totals" style="margin-top:10px"><div class="planner-t"><span class="planner-t-val" style="color:#fbbf24">${mTotShip}</span><span class="planner-t-lbl">12M Expected</span></div><div class="planner-t"><span class="planner-t-val" style="color:#10b981">${mTotDlv} <span style="font-size:12px">(${mTotPct}%)</span></span><span class="planner-t-lbl">Delivered</span></div><div class="planner-t"><span class="planner-t-val" style="color:#f59e0b">${mTotPend}</span><span class="planner-t-lbl">Pending</span></div><div class="planner-t"><span class="planner-t-val" style="color:#34d399">${fc(mTotVal)}</span><span class="planner-t-lbl">Total Value</span></div></div>`;
    // Wrap 12-Month as collapsible
    const moSummary=`<span class="cs-item"><span class="cs-val" style="color:#fbbf24">${mTotShip}</span> expected</span><span class="cs-item"><span class="cs-val" style="color:#10b981">${mTotDlv}</span> delivered</span><span class="cs-item"><span class="cs-val" style="color:#f59e0b">${mTotPend}</span> pending</span>`;
    wh+=makeCollapsible('12mo','<div class="sec-title" style="margin:0"><span class="dot" style="background:var(--pu)"></span> 12-Month Arrival Projection</div>',moContent,moSummary,false);

    // ---- RUNNING DELAYED: Courier ETA > Our ETA (still in-transit) ----
    const delayed=[];
    tr.forEach(r=>{
      if(!r.eta)return;
      const ct=cleanTrk(r.trk);if(!ct)return;
      const courierEta=TRACKED_ETA[ct];if(!courierEta)return;
      const ourDate=new Date(r.eta),courierDate=new Date(courierEta);
      if(isNaN(ourDate)||isNaN(courierDate))return;
      const slipDays=Math.round((courierDate-ourDate)/86400000);
      if(slipDays>0){
        delayed.push({...r,courierEta,slipDays,ourEta:r.eta,trkSts:TRACKED_STS[ct]||'-',lastTrk:TRACKED_TS[ct]||null});
      }
    });
    delayed.sort((a,b)=>b.slipDays-a.slipDays);
    const dTotVal=delayed.reduce((s,r)=>s+(parseVal(r.tval)),0);
    const dConts=new Set(delayed.map(r=>r.cont).filter(Boolean)).size;
    const avgSlip=delayed.length?Math.round(delayed.reduce((s,r)=>s+r.slipDays,0)/delayed.length):0;
    const maxSlip=delayed.length?delayed[0].slipDays:0;

    let dlContent='';
    if(delayed.length===0){
      dlContent+=`<div style="background:var(--c1);border:1px solid var(--c2);border-radius:10px;padding:20px;text-align:center;color:var(--t2);font-size:13px;margin-bottom:16px"><span style="font-size:24px">\u2705</span><br>No running delays detected. All courier ETAs are within committed timelines.</div>`;
    }else{
      dlContent+=`<div class="kpi-grid" style="margin-bottom:14px">`;
      dlContent+=`<div class="kpi kpi-red"><div class="kpi-label">Delayed Shipments</div><div class="kpi-val">${delayed.length}</div><div class="kpi-sub">${tr.length?(delayed.length/tr.length*100).toFixed(0):0}% of in-transit</div></div>`;
      dlContent+=`<div class="kpi kpi-orange"><div class="kpi-label">Avg Slip</div><div class="kpi-val">${avgSlip}d</div><div class="kpi-sub">Courier vs committed</div></div>`;
      dlContent+=`<div class="kpi kpi-purple"><div class="kpi-label">Max Slip</div><div class="kpi-val">${maxSlip}d</div><div class="kpi-sub">Worst case</div></div>`;
      dlContent+=`<div class="kpi kpi-blue"><div class="kpi-label">Value at Risk</div><div class="kpi-val">${fc(dTotVal)}</div><div class="kpi-sub">${dConts} containers</div></div>`;
      dlContent+=`</div>`;
      dlContent+=`<div class="tbl-wrap" style="margin-bottom:16px"><table><thead><tr>`;
      dlContent+=`<th>Invoice</th><th>Mode</th><th>Category</th><th>Container</th><th>Tracking</th><th>Vendor</th><th>Our ETA</th><th>Courier ETA \u{1F4E1}</th><th style="color:var(--rd)">Slip (d)</th><th>Courier Status</th><th>Value</th>`;
      dlContent+=`</tr></thead><tbody>`;
      delayed.forEach(r=>{
        const sevColor=r.slipDays>=14?'var(--rd)':r.slipDays>=7?'#f97316':'#fbbf24';
        const sevIcon=r.slipDays>=14?'\u{1F534}':r.slipDays>=7?'\u{1F7E0}':'\u{1F7E1}';
        const trkAge=r.lastTrk?timeAgo(r.lastTrk):'';
        dlContent+=`<tr style="border-left:3px solid ${sevColor}">`;
        dlContent+=`<td style="font-weight:600">${r.inv||'-'}</td>`;
        dlContent+=`<td>${r.mode||'-'}</td>`;
        dlContent+=`<td><span class="k-badge ${catBadgeCls(r.cat)}">${r.cat||'-'}</span></td>`;
        dlContent+=`<td style="color:#f472b6;font-size:10px" title="${r.cont||''}">${r.cont?(r.cont.length>14?r.cont.substring(0,12)+'..':r.cont):'-'}</td>`;
        dlContent+=`<td>${r.trk?'<a href="'+trkUrl(r.trk,r.mode)+'" target="_blank" style="color:var(--ac);text-decoration:none;font-weight:600">'+r.trk+'</a>':'-'}</td>`;
        dlContent+=`<td>${r.vnd||'-'}</td>`;
        dlContent+=`<td>${r.ourEta}</td>`;
        dlContent+=`<td style="color:#22d3ee;font-weight:600">${r.courierEta}${trkAge?' <span style="font-size:8px;color:var(--t2)">('+trkAge+')</span>':''}</td>`;
        dlContent+=`<td style="font-weight:800;font-size:14px;color:${sevColor}">${sevIcon} +${r.slipDays}d</td>`;
        dlContent+=`<td style="font-size:10px">${r.trkSts}</td>`;
        dlContent+=`<td style="color:#34d399">${fcFull(parseVal(r.tval))}</td>`;
        dlContent+=`</tr>`;
      });
      dlContent+=`</tbody></table></div>`;
      const vndSlip={};delayed.forEach(r=>{const v=r.vnd||'Unknown';if(!vndSlip[v])vndSlip[v]={cnt:0,totSlip:0,val:0};vndSlip[v].cnt++;vndSlip[v].totSlip+=r.slipDays;vndSlip[v].val+=(parseVal(r.tval))});
      const vndArr=Object.entries(vndSlip).sort((a,b)=>b[1].cnt-a[1].cnt);
      if(vndArr.length>1){
        dlContent+=`<div style="background:var(--c1);border:1px solid var(--c2);border-radius:10px;padding:14px 18px;margin-bottom:16px">`;
        dlContent+=`<div style="font-size:10px;font-weight:700;color:var(--rd);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid rgba(239,68,68,.15)">\u{1F3E2} Delay by Vendor</div>`;
        vndArr.forEach(([v,d])=>{
          const avgS=Math.round(d.totSlip/d.cnt);
          dlContent+=`<div style="display:flex;justify-content:space-between;font-size:12px;padding:5px 0;border-bottom:1px solid rgba(71,85,105,.15)"><span style="color:var(--tx);font-weight:600">${v}</span><span style="color:var(--t2)">${d.cnt} shipments \u00B7 avg +${avgS}d \u00B7 ${fc(d.val)} at risk</span></div>`;
        });
        dlContent+=`</div>`;
      }
    }
    // Update parent planner summary
    const ps=document.getElementById('plannerSummary');
    if(ps)ps.innerHTML=`<span class="cs-item"><span class="cs-val" style="color:#fbbf24">${totShip+mTotShip}</span> total</span><span class="cs-item"><span class="cs-val" style="color:#10b981">${totDlv+mTotDlv}</span> delivered</span><span class="cs-item"><span class="cs-val" style="color:#f59e0b">${totPend+mTotPend}</span> pending</span>`;

    wpEl.innerHTML=wh;

    // Render Running Delayed into its own section (after kanban, before planner)
    const dlSecEl=document.getElementById('delayedSection');
    if(dlSecEl){
      const dlSummary=delayed.length>0?`<span class="cs-item"><span class="cs-val" style="color:#f87171">${delayed.length}</span> delayed</span><span class="cs-item"><span class="cs-val" style="color:#fbbf24">avg +${avgSlip}d</span></span><span class="cs-item"><span class="cs-val" style="color:#34d399">${fc(dTotVal)}</span> at risk</span>`:`<span class="cs-item"><span class="cs-val" style="color:#10b981">\u2705</span> No delays</span>`;
      dlSecEl.innerHTML=makeCollapsible('delayed','<div class="sec-title" style="margin:0"><span class="dot" style="background:var(--rd)"></span> \u{1F6A8} Running Delayed</div>',dlContent,dlSummary,delayed.length>0);
    }
  }

  // Transit Table — sort by ETA ascending (soonest first), no ETA at bottom
  tr.sort((a,b)=>{
    const ea=getEffectiveETA(a), eb=getEffectiveETA(b);
    if(!ea&&!eb)return 0;
    if(!ea)return 1;  // no ETA → bottom
    if(!eb)return -1; // no ETA → bottom
    return ea.localeCompare(eb); // ascending: soonest first
  });
  TRANSIT_ROWS=tr; // Store for toggle filtering
  renderTransitTable(tr);

  // Recently Delivered reference section (last 10)
  const dlvRefEl=document.getElementById('deliveredRef');
  const dlvRefTbody=document.getElementById('deliveredRefTbody');
  const dlvRefCount=document.getElementById('deliveredRefCount');
  if(dlvRefEl&&dlvRefTbody){
    if(deliveredTr.length>0){
      dlvRefEl.style.display='block';
      // Sort by tracking timestamp (most recent first), take last 10
      const sorted=deliveredTr.slice().sort((a,b)=>{
        const ta=cleanTrk(a.trk),tb=cleanTrk(b.trk);
        return(TRACKED_TS[tb]||0)-(TRACKED_TS[ta]||0);
      }).slice(0,10);
      if(dlvRefCount)dlvRefCount.textContent=`Showing ${sorted.length} of ${deliveredTr.length} delivered`;
      dlvRefTbody.innerHTML=sorted.map(r=>{
        const ct=cleanTrk(r.trk);const lastTrk=ct?TRACKED_TS[ct]:null;
        const trkTimeStr=lastTrk?fmtTrackTime(lastTrk):'';
        const contDisplay=r.cont?(r.cont.length>14?r.cont.substring(0,12)+'..':r.cont):'-';
        const ie=(r.inv||'').replace(/'/g,"\\'"),te=(r.trk||'').replace(/'/g,"\\'"),ce=(r.cont||'').replace(/'/g,"\\'");
        const isConfirmed=r.delivConfirmed||((r.fsts||'').toLowerCase().includes('received'));
        return`<tr style="background:rgba(16,185,129,.04)">
          <td>${r.inv||'-'}</td>
          <td>${r.mode||'-'}</td>
          <td style="font-size:10px">${r.trk||'-'}</td>
          <td style="font-size:10px;color:#f472b6" title="${r.cont||''}">${contDisplay}</td>
          <td>${r.sku||'-'}/${r.qty||'-'}</td>
          <td>${fcFull(parseVal(r.tval))}</td>
          <td>${r.vnd||'-'}</td>
          <td>${isConfirmed
            ?'<span style="color:#10b981;font-weight:700">\u2705 Confirmed</span><br><span style="font-size:8px;color:var(--t2)">'+(r.fsts||'Delivered')+'</span>'
            :'<div style="display:flex;flex-direction:column;gap:3px;align-items:flex-end"><span style="color:#fbbf24;font-weight:700;font-size:10px">\u26A0 Courier Delivered</span><span style="font-size:8px;color:var(--t2)">Pending your confirmation</span><button class="btn btn-sm" style="font-size:9px;padding:4px 12px;background:linear-gradient(135deg,#10b981,#059669);color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer" onclick="confirmDelivery(\''+te+'\',\''+ce+'\',\''+ie+'\')">\u2705 Confirm Receipt</button></div>'
          }${trkTimeStr?'<br><span style="font-size:8px;color:var(--t2)">'+trkTimeStr+'</span>':''}</td>
        </tr>`;
      }).join('');
    }else{
      dlvRefEl.style.display='none';
    }
  }
}

// Global transit view state
let TRANSIT_VIEW='all';
let TRANSIT_ROWS=[];

function setTransitView(view){
  TRANSIT_VIEW=view;
  document.querySelectorAll('.transit-toggle').forEach(b=>b.classList.remove('active'));
  const btn=document.getElementById(view==='all'?'tglAll':view==='api'?'tglApi':'tglManual');
  if(btn)btn.classList.add('active');
  renderTransitTable(TRANSIT_ROWS);
}

function isApiTracked(r){
  const ct=cleanTrk(r.trk);
  return!!(ct&&TRACKED_TS[ct]&&TRACKED_STS[ct]);
}

function renderTransitTable(tr){
  const tbody=document.getElementById('transitTbody');if(!tbody)return;
  const countEl=document.getElementById('transitViewCount');
  // Filter based on toggle
  let filtered=tr;
  if(TRANSIT_VIEW==='api')filtered=tr.filter(r=>isApiTracked(r));
  else if(TRANSIT_VIEW==='manual')filtered=tr.filter(r=>!isApiTracked(r));
  // Count stats
  const apiCount=tr.filter(r=>isApiTracked(r)).length;
  const manualCount=tr.length-apiCount;
  if(countEl)countEl.textContent=`Showing ${filtered.length} of ${tr.length} \u2022 \u{1F4E1} ${apiCount} API tracked \u2022 \u270F ${manualCount} need manual update`;

  tbody.innerHTML=filtered.map((r,i)=>{
    const globalIdx=tr.indexOf(r);
    const effEta=getEffectiveETA(r);
    const dl=effEta?daysUntil(effEta):'-',isOD=typeof dl==='number'&&dl<0;
    const ct2=cleanTrk(r.trk);const lastTrk=ct2?TRACKED_TS[ct2]:null;
    const onCooldown=lastTrk&&(Date.now()-lastTrk)<TRACK_COOLDOWN;
    const trkTimeStr=lastTrk?fmtTrackTime(lastTrk):'';
    const cooldownTxt=onCooldown?'<div style="font-size:8px;color:#22d3ee;margin-top:2px">\u{1F4E1} '+trkTimeStr+'</div>':(lastTrk?'<div style="font-size:8px;color:#f59e0b;margin-top:2px">\u23F0 '+trkTimeStr+'</div>':'');
    const contEsc=(r.cont||'').replace(/'/g,"\\'");
    const trkEsc=(r.trk||'').replace(/'/g,"\\'");
    const modeEsc=(r.mode||'').replace(/'/g,"\\'");
    const invEsc=(r.inv||'').replace(/'/g,"\\'");
    const hasApi=isApiTracked(r);
    const trkSts=ct2?TRACKED_STS[ct2]:null;

    // Determine tracking link — for containers use container number for carrier page
    let trkLink='-';
    if(r.trk){
      const contNumForLink=r.cont?extractContainerNum(r.cont):null;
      if(isSea({mode:r.mode})&&contNumForLink){
        // For sea with container: show BL number + carrier badge linking to carrier tracking page
        const ct=getContainerTrackUrl(r.cont||r.trk);
        trkLink='<a href="'+ct.url+'" target="_blank" style="color:var(--ac);text-decoration:none;font-weight:600" title="Track container '+ct.contNum+' on '+ct.carrier.name+'">'+r.trk+'</a>'+
          '<div style="margin-top:2px"><a href="'+ct.url+'" target="_blank" style="font-size:8px;padding:1px 6px;background:rgba(6,182,212,.15);color:#06b6d4;border:1px solid rgba(6,182,212,.3);border-radius:4px;text-decoration:none;font-weight:700">\u{1F6A2} '+ct.carrier.name+' \u2197</a></div>';
      }else if(isSea({mode:r.mode})){
        // Sea without container — link to generic tracking
        trkLink='<a href="'+trkUrl(r.trk,r.mode)+'" target="_blank" style="color:var(--ac);text-decoration:none;font-weight:600">'+r.trk+'</a>';
      }else{
        trkLink='<a href="'+trkUrl(r.trk,r.mode)+'" target="_blank" style="color:var(--ac);text-decoration:none;font-weight:600">'+r.trk+'</a>';
      }
    }

    // --- Build tracking events summary from cached data (compact + expandable) ---
    let evtSummary='';
    try{
      const cache=JSON.parse(localStorage.getItem('TRACK_CACHE')||'{}');
      const contNumKey=r.cont?extractContainerNum(r.cont):null;
      const cachedEntry=cache[ct2]||cache[contNumKey];
      if(cachedEntry&&cachedEntry.data){
        const d=cachedEntry.data;
        const uid='evt_'+i+'_'+Date.now();
        // Parcels format
        if(d.states&&d.states.length>0){
          const latest=d.states[0];
          const statusTxt=(latest.status||'').substring(0,45);
          const routeTxt=(d.origin||d.destination)?`${d.origin||'?'} \u27A1 ${d.destination||'?'}`:'';
          // Compact one-liner
          evtSummary=`<div style="margin-top:3px;font-size:9px;color:#22d3ee;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px" onclick="event.stopPropagation();var el=this.nextElementSibling;el.style.display=el.style.display==='none'?'block':'none'" title="Click for details">\u{1F4CD} ${statusTxt}${routeTxt?' \u2022 '+routeTxt:''}</div>`;
          // Expandable detail (hidden by default)
          let detail='<div style="display:none;margin-top:4px;padding:6px 8px;background:rgba(34,211,238,.06);border:1px solid rgba(34,211,238,.12);border-radius:6px;font-size:9px">';
          detail+=`<div style="color:#22d3ee;font-weight:700;margin-bottom:2px">\u{1F4CD} ${(latest.status||'').substring(0,60)}</div>`;
          if(latest.location)detail+=`<div style="color:var(--t2)">\u{1F4CD} ${latest.location.substring(0,50)}</div>`;
          if(latest.date)detail+=`<div style="color:var(--t2)">\u{1F552} ${latest.date.replace('T',' ').substring(0,16)}</div>`;
          if(d.states.length>1){
            const prev=d.states[1];
            detail+=`<div style="color:var(--t2);margin-top:3px;padding-top:3px;border-top:1px solid rgba(71,85,105,.15);">\u2190 ${(prev.status||'').substring(0,50)}`;
            if(prev.date)detail+=` <span style="font-size:8px">(${prev.date.replace('T',' ').substring(0,16)})</span>`;
            detail+=`</div>`;
          }
          if(d.origin||d.destination){
            detail+=`<div style="color:#a78bfa;margin-top:2px;font-weight:600">\u{1F6EB} ${d.origin||'?'} \u27A1 \u{1F6EC} ${d.destination||'?'}</div>`;
          }
          detail+=`</div>`;
          evtSummary+=detail;
        }
        // Legacy 17Track format
        else if(d.track_info){
          const le=d.track_info.latest_event;
          if(le&&le.description){
            evtSummary=`<div style="margin-top:3px;font-size:9px;color:#22d3ee;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px" onclick="event.stopPropagation();var el=this.nextElementSibling;el.style.display=el.style.display==='none'?'block':'none'" title="Click for details">\u{1F4CD} ${(le.description||'').substring(0,45)}</div>`;
            let detail='<div style="display:none;margin-top:4px;padding:6px 8px;background:rgba(34,211,238,.06);border:1px solid rgba(34,211,238,.12);border-radius:6px;font-size:9px">';
            detail+=`<div style="color:#22d3ee;font-weight:700">\u{1F4CD} ${le.description.substring(0,60)}</div>`;
            if(le.time_iso)detail+=`<div style="color:var(--t2)">\u{1F552} ${le.time_iso.replace('T',' ').substring(0,16)}</div>`;
            detail+=`</div>`;
            evtSummary+=detail;
          }
        }
      }
    }catch(e){}

    // Detect if events show delivered but status hasn't been updated yet
    let eventsShowDelivered=false;
    if(trkSts&&trkSts.toLowerCase().includes('deliver')){
      eventsShowDelivered=true;
    }else{
      // Check cached events for delivery keywords
      try{
        const cache2=JSON.parse(localStorage.getItem('TRACK_CACHE')||'{}');
        const contNumKey2=r.cont?extractContainerNum(r.cont):null;
        const c2=cache2[ct2]||cache2[contNumKey2];
        if(c2&&c2.data&&c2.data.states){
          for(let si=0;si<Math.min(3,c2.data.states.length);si++){
            if((c2.data.states[si].status||'').toLowerCase().includes('deliver')){eventsShowDelivered=true;break}
          }
        }
      }catch(e2){}
    }

    // Main row
    let html=`<tr style="${isOD?'background:rgba(239,68,68,.05)':''}${!hasApi&&TRANSIT_VIEW==='manual'?';border-left:3px solid #f59e0b':''}">`;
    html+=`<td>${r.inv||'-'}</td><td>${r.mode||'-'}</td>`;
    html+=`<td><span class="k-badge ${catBadgeCls(r.cat)}">${r.cat||'-'}</span></td>`;
    // Container column — make it clickable to carrier page if available
    if(r.cont){
      const ctForCol=getContainerTrackUrl(r.cont);
      const contDisplay=r.cont.length>14?r.cont.substring(0,12)+'..':r.cont;
      html+=`<td style="font-size:10px" title="${r.cont}"><a href="${ctForCol.url}" target="_blank" style="color:#f472b6;text-decoration:none;font-weight:600">${contDisplay}</a></td>`;
    }else{
      html+=`<td style="color:#f472b6;font-size:10px">-</td>`;
    }
    html+=`<td>${trkLink}${evtSummary}</td>`;
    html+=`<td>${r.sku||'-'}/${r.qty||'-'}</td>`;
    html+=`<td>${fcFull(parseVal(r.tval))}</td>`;
    html+=`<td>${r.vnd||'-'}</td>`;
    // ETA column: show API ETA + original planned ETA
    const tracked=isTrackedETA(r);
    const plannedEta=r.eta||null;
    if(tracked&&plannedEta&&effEta!==plannedEta){
      html+=`<td><div style="line-height:1.3"><span style="color:#22d3ee;font-weight:700">${effEta} \u{1F4E1}</span><br><span style="color:var(--t2);font-size:9px">Planned: ${plannedEta}</span></div></td>`;
    }else{
      html+=`<td>${effEta||'-'}${tracked?'<span style="color:#22d3ee;font-size:8px"> \u{1F4E1}</span>':''}</td>`;
    }
    html+=`<td style="font-weight:700;color:${isOD?'var(--rd)':dl<=7?'var(--or)':'var(--gn)'}">${typeof dl==='number'?(dl<0?dl+'d':dl+'d'):dl}</td>`;

    // Track / Update column
    if(hasApi){
      // API tracked — show status badge + refresh button + last tracked time
      html+=`<td><div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px">`;
      const stsColor2=trkSts&&trkSts.toLowerCase().includes('deliver')?'#10b981':eventsShowDelivered?'#10b981':trkSts&&trkSts.toLowerCase().includes('exception')?'var(--rd)':'#22d3ee';
      const displaySts=eventsShowDelivered?'Delivered':(trkSts||'Tracked');
      html+=`<span style="font-size:9px;color:${stsColor2};font-weight:700">${eventsShowDelivered?'\u2705':'\u{1F4E1}'} ${displaySts}</span>`;
      if(eventsShowDelivered&&!(trkSts&&trkSts.toLowerCase().includes('deliver'))){
        // Events show delivered but stored status doesn't — offer to mark as delivered
        html+=`<button class="btn btn-sm" style="font-size:9px;padding:3px 10px;background:linear-gradient(135deg,#10b981,#059669);color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer;box-shadow:0 2px 6px rgba(16,185,129,.3)" onclick="confirmDelivery('${trkEsc}','${contEsc}','${invEsc}')">\u2705 Confirm Delivery</button>`;
      }
      if(onCooldown){
        html+=`<span style="font-size:8px;color:var(--t2)">\u2705 Checked ${timeAgo(lastTrk)}</span>`;
        html+=`<button class="btn btn-sm" style="font-size:8px;padding:2px 6px;opacity:.5;cursor:not-allowed;background:rgba(100,116,139,.15);color:var(--t2);border:1px solid rgba(100,116,139,.2)" disabled title="Tracked ${trkTimeStr} — wait 3h">\u{23F3} Cooldown</button>`;
      }else{
        if(lastTrk)html+=`<span style="font-size:8px;color:#f59e0b">\u23F0 Last: ${trkTimeStr}</span>`;
        html+=`<button class="btn btn-sm" style="font-size:9px;padding:2px 8px;background:rgba(34,211,238,.15);color:#22d3ee;border:1px solid rgba(34,211,238,.3)" onclick="trackOne('${trkEsc}','${modeEsc}',${globalIdx},'${contEsc}')">\u{1F504} Refresh</button>`;
      }
      html+=`</div></td>`;
    }else{
      // No API data — show Track button + inline manual update
      html+=`<td><div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">`;
      if(eventsShowDelivered){
        html+=`<span style="font-size:9px;color:#10b981;font-weight:700">\u2705 Delivered</span>`;
        html+=`<button class="btn btn-sm" style="font-size:9px;padding:3px 10px;background:linear-gradient(135deg,#10b981,#059669);color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer;box-shadow:0 2px 6px rgba(16,185,129,.3)" onclick="confirmDelivery('${trkEsc}','${contEsc}','${invEsc}')">\u2705 Confirm Delivery</button>`;
      }
      if(r.trk){
        if(onCooldown){
          html+=`<span style="font-size:8px;color:var(--t2)">\u2705 Checked ${timeAgo(lastTrk)}</span>`;
          html+=`<button class="btn btn-sm" style="font-size:8px;padding:2px 6px;opacity:.5;cursor:not-allowed;background:rgba(100,116,139,.15);color:var(--t2);border:1px solid rgba(100,116,139,.2)" disabled>\u{23F3} Cooldown</button>`;
        }else{
          html+=`<button class="btn btn-or btn-sm" style="font-size:10px" onclick="trackOne('${trkEsc}','${modeEsc}',${globalIdx},'${contEsc}')">Track</button>`;
        }
      }
      html+=`<button class="btn btn-sm" style="font-size:10px;padding:4px 10px;background:linear-gradient(135deg,rgba(249,115,22,.2),rgba(234,179,8,.2));color:#f59e0b;border:1px solid rgba(249,115,22,.4);font-weight:700" onclick="toggleInlineManual(${globalIdx})">\u270F Update ETA</button>`;
      if(lastTrk)html+=`<span style="font-size:7px;color:var(--t2)">\u23F0 ${trkTimeStr}</span>`;
      html+=`</div></td>`;
    }
    html+=`</tr>`;

    // Tracking result row (for popup/API results)
    html+=`<tr><td colspan="11"><div id="trkRes${globalIdx}" style="display:none;padding:8px;background:var(--bg);border-radius:6px;font-size:11px;margin:4px 0"></div></td></tr>`;

    // Inline manual save row — auto-show in "manual" view, hidden in others
    const today=new Date().toISOString().substring(0,10);
    const curEta=effEta||today;
    const showManualRow=(!hasApi&&TRANSIT_VIEW==='manual');
    html+=`<tr id="manualRow${globalIdx}" style="display:${showManualRow?'':'none'}" class="manual-save-row"><td colspan="11">`;
    html+=`<div style="padding:10px 14px;background:linear-gradient(135deg,rgba(249,115,22,0.05),rgba(59,130,246,0.05));border:1px solid rgba(249,115,22,0.2);border-radius:10px;margin:2px 0">`;
    html+=`<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">`;
    html+=`<span style="font-size:12px;font-weight:700;color:#f59e0b">\u270F Manual Update</span>`;
    html+=`<span style="font-size:10px;color:var(--t2)">for ${r.inv||r.trk||'-'}</span>`;

    // If sea/container — add direct carrier tracking link
    if(isSea({mode:r.mode})&&r.cont){
      const ct=getContainerTrackUrl(r.cont);
      html+=`<a href="${ct.url}" target="_blank" style="font-size:10px;color:var(--ac);text-decoration:none;margin-left:auto;font-weight:600">\u{1F6A2} Open ${ct.carrier.name} Tracking \u2197</a>`;
    }else if(isAWB(r.trk)){
      html+=`<a href="${trkUrl(r.trk,r.mode)}" target="_blank" style="font-size:10px;color:var(--ac);text-decoration:none;margin-left:auto;font-weight:600">\u2708\uFE0F Track AWB \u2197</a>`;
    }else if(r.trk){
      html+=`<a href="${trkUrl(r.trk,r.mode)}" target="_blank" style="font-size:10px;color:var(--ac);text-decoration:none;margin-left:auto;font-weight:600">\u{1F4E6} Open Tracking \u2197</a>`;
    }
    html+=`</div>`;
    html+=`<div class="inline-save">`;
    html+=`<select id="mSts${globalIdx}"><option value="">-- Status --</option><option value="In Transit" selected>In Transit</option><option value="Delivered">Delivered</option><option value="Arrived at Port">Arrived at Port</option><option value="Customs Clearance">Customs Clearance</option><option value="On Vessel">On Vessel</option><option value="Departed Port">Departed Port</option><option value="Out for Delivery">Out for Delivery</option><option value="Info Received">Info Received</option><option value="Exception">Exception</option></select>`;
    html+=`<input type="date" id="mEta${globalIdx}" value="${curEta}"/>`;
    html+=`<button onclick="saveInlineManual('${trkEsc||r.inv}',${globalIdx})">\u2705 Save</button>`;
    html+=`<span id="mMsg${globalIdx}" class="save-msg"></span>`;
    html+=`</div></div></td></tr>`;

    return html;
  }).join('');
}

// Toggle inline manual update row
function toggleInlineManual(idx){
  const row=document.getElementById('manualRow'+idx);
  if(!row)return;
  row.style.display=row.style.display==='none'?'':'none';
}

// Save from inline manual update
function saveInlineManual(num,idx){
  const stsEl=document.getElementById('mSts'+idx);
  const etaEl=document.getElementById('mEta'+idx);
  const msgEl=document.getElementById('mMsg'+idx);
  if(!stsEl||!etaEl)return;
  const sts=stsEl.value;const eta=etaEl.value;
  if(!sts&&!eta){if(msgEl){msgEl.style.color='#f87171';msgEl.textContent='\u26A0 Select status and/or date'}return}
  console.log('saveInlineManual:',num,'status:',sts,'eta:',eta);
  saveTrackedInfo(num,eta||null,sts||null);
  // Create synthetic tracking data
  const syntheticInfo={track_info:{
    latest_status:{status:(sts||'InTransit').replace(/\s+/g,'')},
    latest_event:{time_iso:eta?eta+'T00:00:00':'',description:'Manually updated: '+sts,location:''},
    time_metrics:eta?{estimated_delivery_date:eta}:undefined,
    tracking:{providers:[{events:[{time_iso:eta?eta+'T00:00:00':'',description:'Status: '+sts+' (manual update)',location:''}]}]}
  }};
  try{
    const cache=JSON.parse(localStorage.getItem('TRACK_CACHE')||'{}');
    cache[num]={ts:Date.now(),data:syntheticInfo};
    localStorage.setItem('TRACK_CACHE',JSON.stringify(cache));
  }catch(e){}
  saveTrackCacheToFirebase(num,syntheticInfo);
  if(msgEl){msgEl.style.color='#10b981';msgEl.textContent='\u2705 Saved!'}
  // Refresh after brief delay
  setTimeout(()=>{if(initialized)renderAll()},800);
}

// ============ TAB 1: DELIVERED & COMPLETED ============
function renderDelivered(){
  const dlv=FD.filter(r=>{const s=(r.fsts||'').toLowerCase();return s.includes('received')||s.includes('delivered')||s.includes('ams')||!!r.aeta});
  const el=document.getElementById('dlvKpi');if(!el)return;
  const tv=dlv.reduce((s,r)=>s+(parseVal(r.tval)),0),tq=dlv.reduce((s,r)=>s+(parseVal(r.qty)),0);
  // Lead time for delivered
  const withLT=[];dlv.forEach(r=>{if(!r.dt)return;const arr=r.aeta||r.eta;if(!arr)return;const d=Math.round((new Date(arr)-new Date(r.dt))/86400000);if(d>0&&d<=365)withLT.push({...r,leadDays:d})});
  const avgLT=withLT.length?withLT.reduce((s,r)=>s+r.leadDays,0)/withLT.length:0;
  // On-time calculation
  const withBoth=dlv.filter(r=>r.eta&&r.aeta);
  const onTime=withBoth.filter(r=>new Date(r.aeta)<=new Date(r.eta)).length;
  const onTimePct=withBoth.length?(onTime/withBoth.length*100):0;
  const late=withBoth.length-onTime;
  const contDlv=new Set(dlv.map(r=>r.cont).filter(Boolean)).size;
  const dlvVQ=VMODE==='qty'?tq.toLocaleString()+' pcs':fc(tv);
  el.innerHTML=
    `<div class="kpi kpi-green clickable" onclick="showKpiDetail('All Delivered Shipments',r=>{const s=(r.fsts||'').toLowerCase();return s.includes('received')||s.includes('delivered')||s.includes('ams')||!!r.aeta})"><div class="kpi-label">Delivered</div><div class="kpi-val">${dlv.length.toLocaleString()}</div><div class="kpi-sub">${(FD.length?dlv.length/FD.length*100:0).toFixed(0)}% of filtered</div><div class="click-hint">Click to view</div></div>`+
    `<div class="kpi kpi-blue"><div class="kpi-label">${VMODE==='qty'?'Delivered Qty':'Delivered Value'}</div><div class="kpi-val">${dlvVQ}</div><div class="kpi-sub">${VMODE==='qty'?fc(tv)+' value':tq.toLocaleString()+' pcs'}</div></div>`+
    `<div class="kpi kpi-cyan"><div class="kpi-label">Avg Lead Time</div><div class="kpi-val">${avgLT.toFixed(1)}d</div><div class="kpi-sub">${withLT.length} with data</div></div>`+
    `<div class="kpi kpi-green clickable" onclick="showKpiDetail('On-Time Deliveries',r=>{if(!r.eta||!r.aeta)return false;return new Date(r.aeta)<=new Date(r.eta)})"><div class="kpi-label">On-Time Rate</div><div class="kpi-val">${onTimePct.toFixed(0)}%</div><div class="kpi-sub">${onTime} of ${withBoth.length} on time</div><div class="click-hint">Click to view</div></div>`+
    `<div class="kpi kpi-red clickable" onclick="showKpiDetail('Late Deliveries',r=>{if(!r.eta||!r.aeta)return false;return new Date(r.aeta)>new Date(r.eta)})"><div class="kpi-label">Late Deliveries</div><div class="kpi-val">${late}</div><div class="kpi-sub">${withBoth.length?(late/withBoth.length*100).toFixed(0):0}% of tracked</div><div class="click-hint">Click to view</div></div>`+
    `<div class="kpi kpi-purple clickable" onclick="showKpiDetail('Delivered Containers',r=>{const s=(r.fsts||'').toLowerCase();return (s.includes('received')||s.includes('delivered')||s.includes('ams')||!!r.aeta)&&r.cont})"><div class="kpi-label">Containers</div><div class="kpi-val">${contDlv}</div><div class="kpi-sub">Unique delivered</div><div class="click-hint">Click to view</div></div>`;

  // Monthly deliveries — stacked JP/LSP
  const dmm={};dlv.forEach(r=>{const _d=getRecDate(r);if(!_d)return;const m=_d.substring(0,7);const c=(r.cat||'').toUpperCase();const isJP=c==='JP'||c.includes('JP SAMPLE');if(!dmm[m])dmm[m]={c:0,v:0,jpC:0,jpV:0,njpC:0,njpV:0};dmm[m].c++;dmm[m].v+=parseVal(r.tval);if(isJP){dmm[m].jpC++;dmm[m].jpV+=parseVal(r.tval)}else{dmm[m].njpC++;dmm[m].njpV+=parseVal(r.tval)}});
  const dmk=Object.keys(dmm).sort();
  const dLbl=dmk.map(k=>{const[y,m]=k.split('-');return MNAMES[parseInt(m)-1]+" '"+y.slice(2)});
  const dlvStk=document.getElementById('dlvStackToggle')?.checked;
  if(dlvStk){
    if(charts['chDlvMonth']){charts['chDlvMonth'].destroy();delete charts['chDlvMonth']}
    const ctx=document.getElementById('chDlvMonth');if(ctx)charts['chDlvMonth']=new Chart(ctx,{type:'bar',data:{labels:dLbl,datasets:[
      {label:'JP',data:dmk.map(k=>dmm[k].jpC),backgroundColor:'rgba(59,130,246,.7)',borderRadius:3},
      {label:'NJP/LSP',data:dmk.map(k=>dmm[k].njpC),backgroundColor:'rgba(139,92,246,.7)',borderRadius:3}
    ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,position:'top',labels:{color:'#94a3b8',boxWidth:10,padding:6,font:{size:10}}}},scales:{x:{stacked:true,ticks:{color:'#64748b',font:{size:9},maxRotation:45},grid:{color:'rgba(51,65,85,.3)'}},y:{stacked:true,ticks:{color:'#64748b',font:{size:9}},grid:{color:'rgba(51,65,85,.3)'},beginAtZero:true}}}});
  }else{
    mkC2('chDlvMonth','bar',dLbl,[
      {label:'Deliveries',data:dmk.map(k=>dmm[k].c),backgroundColor:'rgba(16,185,129,.6)',borderRadius:3,yAxisID:'y'},
      {label:'Value ('+CUR+')',data:dmk.map(k=>Math.round(dmm[k].v*CRATE[CUR])),type:'line',borderColor:'#f59e0b',fill:false,tension:.3,pointRadius:2,yAxisID:'y1'}
    ],{scales:{x:{ticks:{color:'#64748b',font:{size:9},maxRotation:45},grid:{color:'rgba(51,65,85,.3)'}},y:{position:'left',ticks:{color:'#64748b',font:{size:9}},grid:{color:'rgba(51,65,85,.3)'},beginAtZero:true,title:{display:true,text:'Count',color:'#64748b'}},y1:{position:'right',ticks:{color:'#64748b',font:{size:9}},grid:{drawOnChartArea:false},beginAtZero:true,title:{display:true,text:'Value',color:'#64748b'}}}});
  }

  // By mode
  const mo={};dlv.forEach(r=>{const k=r.mode||'Unknown';mo[k]=(mo[k]||0)+1});
  const mok=Object.keys(mo).sort((a,b)=>mo[b]-mo[a]).slice(0,10);
  mkC('chDlvMode','doughnut',mok,[{data:mok.map(k=>mo[k]),backgroundColor:COLORS,borderWidth:0}],true);

  // By category
  const ca={};dlv.forEach(r=>{const k=r.cat||'Unknown';ca[k]=(ca[k]||0)+1});
  const cak=Object.keys(ca).sort((a,b)=>ca[b]-ca[a]);
  mkC('chDlvCat','bar',cak,[{label:'Delivered',data:cak.map(k=>ca[k]),backgroundColor:cak.map((_,i)=>COLORS[i%COLORS.length]+'99'),borderRadius:4}]);

  // Lead time by mode
  const ltm={};withLT.forEach(r=>{const m=r.mode||'Other';if(!ltm[m])ltm[m]={sum:0,cnt:0};ltm[m].sum+=r.leadDays;ltm[m].cnt++});
  const ltk=Object.keys(ltm).sort((a,b)=>ltm[b].cnt-ltm[a].cnt).slice(0,10);
  mkC2('chDlvLT','bar',ltk.map(k=>k.length>16?k.substring(0,14)+'..':k),[
    {label:'Avg Lead Time',data:ltk.map(k=>(ltm[k].sum/ltm[k].cnt).toFixed(1)),backgroundColor:ltk.map((_,i)=>COLORS[i%COLORS.length]+'99'),borderRadius:4,yAxisID:'y'},
    {label:'Count',data:ltk.map(k=>ltm[k].cnt),type:'line',borderColor:'#94a3b8',pointRadius:3,borderWidth:1.5,fill:false,yAxisID:'y1'}
  ],{scales:{x:{ticks:{color:'#64748b',font:{size:9},maxRotation:45},grid:{color:'rgba(51,65,85,.3)'}},y:{position:'left',ticks:{color:'#64748b',font:{size:9}},grid:{color:'rgba(51,65,85,.3)'},beginAtZero:true,title:{display:true,text:'Days',color:'#64748b'}},y1:{position:'right',ticks:{color:'#64748b',font:{size:9}},grid:{drawOnChartArea:false},beginAtZero:true,title:{display:true,text:'Count',color:'#64748b'}}}});

  // Delivered table
  const sorted=[...dlv].sort((a,b)=>(b.dt||'').localeCompare(a.dt||''));
  const dlvPg=sorted.slice(0,100);
  const tb=document.getElementById('dlvTbody');
  if(tb)tb.innerHTML=dlvPg.map(r=>{
    const arr=r.aeta||r.eta;const lt=(r.dt&&arr)?Math.round((new Date(arr)-new Date(r.dt))/86400000):'-';
    return`<tr><td>${r.dt||'-'}</td><td>${r.inv||'-'}</td><td>${r.mode||'-'}</td><td><span class="k-badge ${catBadgeCls(r.cat)}">${r.cat||'-'}</span></td><td style="color:#f472b6;font-size:10px">${r.cont||'-'}</td><td>${r.sku||'-'}/${r.qty||'-'}</td><td>${fcFull(parseVal(r.tval))}</td><td>${r.vnd||'-'}</td><td>${r.eta||'-'}</td><td>${r.aeta||'-'}</td><td style="font-weight:700;color:${typeof lt==='number'?(lt>30?'var(--rd)':lt>14?'var(--or)':'var(--gn)'):'var(--t2)'}">${typeof lt==='number'?lt+'d':lt}</td><td>${stsBadge(r.fsts)}</td></tr>`;
  }).join('');
  const dlvCnt=document.getElementById('dlvCount');if(dlvCnt)dlvCnt.textContent=dlv.length+' delivered (showing first 100)';
}

// ============ TAB 2: BOTTLENECKS & DELAYS ============
function renderBottlenecks(){
  // Compute delayed records
  const delayed=[];
  FD.forEach(r=>{if(!r.eta)return;const eta=new Date(r.eta);if(isNaN(eta))return;let actual=null;if(r.aeta){actual=new Date(r.aeta);if(isNaN(actual))actual=null}if(!actual&&isTrans(r))actual=new Date();if(!actual)return;const days=Math.round((actual-eta)/86400000);if(days>0&&days<=365)delayed.push({...r,delayDays:days})});
  delayed.sort((a,b)=>b.delayDays-a.delayDays);
  const avg=delayed.length?delayed.reduce((s,r)=>s+r.delayDays,0)/delayed.length:0;
  const mx=delayed.length?delayed[0].delayDays:0;
  const seaD=delayed.filter(r=>isSea(r)),airD=delayed.filter(r=>isAir(r));
  const delayRate=FD.length?(delayed.length/FD.length*100):0;

  // MoM improvement: last 3 months vs previous 3 months
  const now=new Date();const mmDelay={};
  delayed.forEach(r=>{const _d=getRecDate(r);if(!_d)return;const m=_d.substring(0,7);if(!mmDelay[m])mmDelay[m]={sum:0,cnt:0};mmDelay[m].sum+=r.delayDays;mmDelay[m].cnt++});
  const sortedMonths=Object.keys(mmDelay).sort().reverse();
  const last3=sortedMonths.slice(0,3),prev3=sortedMonths.slice(3,6);
  const avgLast3=last3.length?last3.reduce((s,m)=>s+(mmDelay[m].sum/mmDelay[m].cnt),0)/last3.length:0;
  const avgPrev3=prev3.length?prev3.reduce((s,m)=>s+(mmDelay[m].sum/mmDelay[m].cnt),0)/prev3.length:0;
  const improvement=avgPrev3>0?((avgPrev3-avgLast3)/avgPrev3*100):0;
  const impIcon=improvement>0?'\u2705':improvement<0?'\u{1F534}':'\u2796';
  const impText=improvement>0?Math.abs(improvement).toFixed(0)+'% improved':improvement<0?Math.abs(improvement).toFixed(0)+'% worsened':'No change';

  const el=document.getElementById('delayKpi');
  if(el)el.innerHTML=
    `<div class="kpi kpi-red clickable" onclick="showKpiDetail('Delayed Shipments',r=>{if(!r.eta||!r.aeta)return false;return Math.round((new Date(r.aeta)-new Date(r.eta))/86400000)>0})"><div class="kpi-label">Delayed Shipments</div><div class="kpi-val">${delayed.length}</div><div class="kpi-sub">${delayRate.toFixed(1)}% delay rate</div><div class="click-hint">Click to view</div></div>`+
    `<div class="kpi kpi-orange"><div class="kpi-label">Avg Delay</div><div class="kpi-val">${avg.toFixed(1)}d</div><div class="kpi-sub">Days past ETA</div></div>`+
    `<div class="kpi kpi-purple"><div class="kpi-label">Max Delay</div><div class="kpi-val">${mx}d</div><div class="kpi-sub">Worst case</div></div>`+
    `<div class="kpi kpi-blue"><div class="kpi-label">Sea / Air Delayed</div><div class="kpi-val">${seaD.length} / ${airD.length}</div><div class="kpi-sub">By transport type</div></div>`+
    `<div class="kpi ${improvement>=0?'kpi-green':'kpi-red'}"><div class="kpi-label">MoM Trend</div><div class="kpi-val">${impIcon} ${impText}</div><div class="kpi-sub">Last 3mo vs prev 3mo avg delay</div></div>`;

  // Chart: Avg delay by mode
  const typeDelay={'Sea':{sum:0,cnt:0},'Air':{sum:0,cnt:0},'Other':{sum:0,cnt:0}};
  delayed.forEach(r=>{const k=isSea(r)?'Sea':isAir(r)?'Air':'Other';typeDelay[k].sum+=r.delayDays;typeDelay[k].cnt++});
  const tdKeys=Object.keys(typeDelay).filter(k=>typeDelay[k].cnt>0);
  mkC('chDelayType','bar',tdKeys,[{label:'Avg Delay (d)',data:tdKeys.map(k=>(typeDelay[k].sum/typeDelay[k].cnt).toFixed(1)),backgroundColor:['rgba(34,211,238,.6)','rgba(59,130,246,.6)','rgba(139,92,246,.6)'],borderRadius:5}]);

  // Distribution
  const bkt={'1-3d':0,'4-7d':0,'8-14d':0,'15-30d':0,'30+d':0};
  delayed.forEach(r=>{if(r.delayDays<=3)bkt['1-3d']++;else if(r.delayDays<=7)bkt['4-7d']++;else if(r.delayDays<=14)bkt['8-14d']++;else if(r.delayDays<=30)bkt['15-30d']++;else bkt['30+d']++});
  mkC('chDelayDist','bar',Object.keys(bkt),[{label:'Shipments',data:Object.values(bkt),backgroundColor:['rgba(16,185,129,.6)','rgba(59,130,246,.6)','rgba(245,158,11,.6)','rgba(239,68,68,.6)','rgba(220,38,38,.8)'],borderRadius:5}]);

  // Worst vendors
  const vd={};delayed.forEach(r=>{const v=r.vnd||'?';if(!vd[v])vd[v]={sum:0,cnt:0};vd[v].sum+=r.delayDays;vd[v].cnt++});
  const tvd=Object.entries(vd).sort((a,b)=>(b[1].sum/b[1].cnt)-(a[1].sum/a[1].cnt)).slice(0,10);
  mkC('chDelayVnd','bar',tvd.map(v=>v[0].length>18?v[0].substring(0,16)+'..':v[0]),[{label:'Avg Delay (d)',data:tvd.map(v=>(v[1].sum/v[1].cnt).toFixed(1)),backgroundColor:'rgba(239,68,68,.5)',borderRadius:4}]);

  // By location
  const ld={};delayed.forEach(r=>{const l=r.loc||'?';if(!ld[l])ld[l]={sum:0,cnt:0};ld[l].sum+=r.delayDays;ld[l].cnt++});
  const tld=Object.entries(ld).sort((a,b)=>b[1].cnt-a[1].cnt);
  mkC('chDelayLoc','bar',tld.map(v=>v[0]),[{label:'Count',data:tld.map(v=>v[1].cnt),backgroundColor:'rgba(245,158,11,.5)',borderRadius:4},{label:'Avg Days',data:tld.map(v=>(v[1].sum/v[1].cnt).toFixed(1)),backgroundColor:'rgba(239,68,68,.5)',borderRadius:4}]);

  // Monthly delay trend (KEY chart)
  const mKeys=Object.keys(mmDelay).sort();
  const mLabels=mKeys.map(k=>{const[y,m]=k.split('-');return MNAMES[parseInt(m)-1]+" '"+y.slice(2)});
  mkC2('chDelayMonth','bar',mLabels,[
    {label:'Count',data:mKeys.map(m=>mmDelay[m].cnt),backgroundColor:'rgba(239,68,68,.5)',borderRadius:3,yAxisID:'y'},
    {label:'Avg Delay (d)',data:mKeys.map(m=>(mmDelay[m].sum/mmDelay[m].cnt).toFixed(1)),type:'line',borderColor:'#ef4444',backgroundColor:'rgba(239,68,68,.1)',fill:true,tension:.3,pointRadius:3,yAxisID:'y1'}
  ],{scales:{x:{ticks:{color:'#64748b',font:{size:9},maxRotation:45},grid:{color:'rgba(51,65,85,.3)'}},y:{position:'left',ticks:{color:'#64748b',font:{size:9}},grid:{color:'rgba(51,65,85,.3)'},beginAtZero:true,title:{display:true,text:'Count',color:'#64748b'}},y1:{position:'right',ticks:{color:'#64748b',font:{size:9}},grid:{drawOnChartArea:false},beginAtZero:true,title:{display:true,text:'Avg Days',color:'#64748b'}}}});

  // Monthly Air vs Sea delays
  const am={};delayed.forEach(r=>{const _d=getRecDate(r);if(!_d)return;const m=_d.substring(0,7),t=isSea(r)?'Sea':'Air';if(!am[m])am[m]={Sea:0,Air:0};am[m][t]++});
  const aKeys=Object.keys(am).sort();
  const aLabels=aKeys.map(k=>{const[y,m]=k.split('-');return MNAMES[parseInt(m)-1]+" '"+y.slice(2)});
  mkC('chDelayAirSea','bar',aLabels,[
    {label:'Sea',data:aKeys.map(m=>am[m].Sea),backgroundColor:'rgba(34,211,238,.6)',borderRadius:3},
    {label:'Air',data:aKeys.map(m=>am[m].Air),backgroundColor:'rgba(59,130,246,.6)',borderRadius:3}
  ]);

  // Quarterly trend
  const qDelay={};delayed.forEach(r=>{const _d=getRecDate(r);if(!_d)return;const tp=getTimePeriod(_d,'quarter');if(!tp)return;if(!qDelay[tp])qDelay[tp]={sum:0,cnt:0};qDelay[tp].sum+=r.delayDays;qDelay[tp].cnt++});
  const qKeys=Object.keys(qDelay).sort();
  mkC2('chDelayQtr','bar',qKeys,[
    {label:'Delayed Count',data:qKeys.map(k=>qDelay[k].cnt),backgroundColor:'rgba(139,92,246,.5)',borderRadius:3,yAxisID:'y'},
    {label:'Avg Delay (d)',data:qKeys.map(k=>(qDelay[k].sum/qDelay[k].cnt).toFixed(1)),type:'line',borderColor:'#f59e0b',fill:false,tension:.3,pointRadius:3,yAxisID:'y1'}
  ],{scales:{x:{ticks:{color:'#64748b',font:{size:9},maxRotation:45},grid:{color:'rgba(51,65,85,.3)'}},y:{position:'left',ticks:{color:'#64748b',font:{size:9}},grid:{color:'rgba(51,65,85,.3)'},beginAtZero:true,title:{display:true,text:'Count',color:'#64748b'}},y1:{position:'right',ticks:{color:'#64748b',font:{size:9}},grid:{drawOnChartArea:false},beginAtZero:true,title:{display:true,text:'Avg Days',color:'#64748b'}}}});

  // MoM improvement chart
  const momData=[];
  for(let i=1;i<mKeys.length;i++){
    const prevAvg=mmDelay[mKeys[i-1]].sum/mmDelay[mKeys[i-1]].cnt;
    const curAvg=mmDelay[mKeys[i]].sum/mmDelay[mKeys[i]].cnt;
    momData.push({month:mKeys[i],change:((curAvg-prevAvg)/prevAvg*100)});
  }
  if(momData.length){
    const momLbl=momData.map(d=>{const[y,m]=d.month.split('-');return MNAMES[parseInt(m)-1]+" '"+y.slice(2)});
    mkC('chDelayMoM','bar',momLbl,[{label:'MoM Change %',data:momData.map(d=>d.change.toFixed(1)),backgroundColor:momData.map(d=>d.change<=0?'rgba(16,185,129,.6)':'rgba(239,68,68,.6)'),borderRadius:4}]);
  }

  // ---- COMMITMENT VS REALITY ----
  const gapRecords=[];
  FD.forEach(r=>{if(!r.eta||!r.aeta)return;const eta=new Date(r.eta),aeta=new Date(r.aeta);if(isNaN(eta)||isNaN(aeta))return;const gapDays=Math.round((aeta-eta)/86400000);if(Math.abs(gapDays)<=365)gapRecords.push({...r,gapDays})});
  const gapEl=document.getElementById('gapKpi');
  if(gapRecords.length&&gapEl){
    const avgGap=gapRecords.reduce((s,r)=>s+r.gapDays,0)/gapRecords.length;
    const lateRecs=gapRecords.filter(r=>r.gapDays>0),earlyRecs=gapRecords.filter(r=>r.gapDays<=0);
    const onTimeRate=gapRecords.length?(earlyRecs.length/gapRecords.length*100):0;
    const avgLate=lateRecs.length?lateRecs.reduce((s,r)=>s+r.gapDays,0)/lateRecs.length:0;
    gapEl.innerHTML=
      `<div class="kpi kpi-blue"><div class="kpi-label">With Both Dates</div><div class="kpi-val">${gapRecords.length}</div><div class="kpi-sub">ETA &amp; actual</div></div>`+
      `<div class="kpi ${avgGap>0?'kpi-red':'kpi-green'}"><div class="kpi-label">Avg Gap</div><div class="kpi-val">${avgGap>0?'+':''}${avgGap.toFixed(1)}d</div><div class="kpi-sub">${avgGap>0?'Late':'Early'} avg</div></div>`+
      `<div class="kpi kpi-green"><div class="kpi-label">On-Time %</div><div class="kpi-val">${onTimeRate.toFixed(0)}%</div><div class="kpi-sub">${earlyRecs.length} on time/early</div></div>`+
      `<div class="kpi kpi-red"><div class="kpi-label">Late</div><div class="kpi-val">${lateRecs.length}</div><div class="kpi-sub">Avg ${avgLate.toFixed(1)}d late</div></div>`;
    // Gap by mode
    const gMode={};gapRecords.forEach(r=>{const k=isSea(r)?'Sea':isAir(r)?'Air':r.mode||'Other';if(!gMode[k])gMode[k]={cSum:0,aSum:0,cnt:0,late:0};const dt=new Date(r.dt),eta=new Date(r.eta),aeta=new Date(r.aeta);gMode[k].cSum+=Math.round((eta-dt)/86400000);gMode[k].aSum+=Math.round((aeta-dt)/86400000);gMode[k].cnt++;if(r.gapDays>0)gMode[k].late++});
    const gmKeys=Object.keys(gMode).sort((a,b)=>gMode[b].cnt-gMode[a].cnt);
    mkC('chGapMode','bar',gmKeys,[
      {label:'Committed (ETA)',data:gmKeys.map(k=>(gMode[k].cSum/gMode[k].cnt).toFixed(1)),backgroundColor:'rgba(59,130,246,.6)',borderRadius:4},
      {label:'Actual',data:gmKeys.map(k=>(gMode[k].aSum/gMode[k].cnt).toFixed(1)),backgroundColor:'rgba(239,68,68,.6)',borderRadius:4}
    ]);
    // Gap by vendor
    const gVnd={};gapRecords.forEach(r=>{const v=r.vnd||'?';if(!gVnd[v])gVnd[v]={sum:0,cnt:0};gVnd[v].sum+=r.gapDays;gVnd[v].cnt++});
    const gvE=Object.entries(gVnd).filter(e=>e[1].cnt>=2).sort((a,b)=>(b[1].sum/b[1].cnt)-(a[1].sum/a[1].cnt)).slice(0,10);
    mkC('chGapVnd','bar',gvE.map(e=>e[0].length>16?e[0].substring(0,14)+'..':e[0]),[{label:'Avg Gap (d)',data:gvE.map(e=>(e[1].sum/e[1].cnt).toFixed(1)),backgroundColor:gvE.map(e=>(e[1].sum/e[1].cnt)>0?'rgba(239,68,68,.6)':'rgba(16,185,129,.6)'),borderRadius:4}]);
    // Monthly gap trend
    const gMon={};gapRecords.forEach(r=>{const _d=getRecDate(r);if(!_d)return;const m=_d.substring(0,7);if(!gMon[m])gMon[m]={sum:0,cnt:0,late:0};gMon[m].sum+=r.gapDays;gMon[m].cnt++;if(r.gapDays>0)gMon[m].late++});
    const gmk=Object.keys(gMon).sort();
    const gml=gmk.map(k=>{const[y,m]=k.split('-');return MNAMES[parseInt(m)-1]+" '"+y.slice(2)});
    mkC2('chGapMonth','bar',gml,[
      {label:'Avg Gap (d)',data:gmk.map(m=>(gMon[m].sum/gMon[m].cnt).toFixed(1)),backgroundColor:gmk.map(m=>(gMon[m].sum/gMon[m].cnt)>0?'rgba(239,68,68,.5)':'rgba(16,185,129,.5)'),borderRadius:3,yAxisID:'y'},
      {label:'On-Time %',data:gmk.map(m=>((gMon[m].cnt-gMon[m].late)/gMon[m].cnt*100).toFixed(0)),type:'line',borderColor:'#10b981',fill:false,tension:.3,pointRadius:2,yAxisID:'y1'}
    ],{scales:{x:{ticks:{color:'#64748b',font:{size:9},maxRotation:45},grid:{color:'rgba(51,65,85,.3)'}},y:{position:'left',ticks:{color:'#64748b',font:{size:9}},grid:{color:'rgba(51,65,85,.3)'},title:{display:true,text:'Gap (d)',color:'#64748b'}},y1:{position:'right',ticks:{color:'#64748b',font:{size:9}},grid:{drawOnChartArea:false},min:0,max:100,title:{display:true,text:'On-Time %',color:'#64748b'}}}});
    // On-time by mode
    mkC('chGapOnTime','bar',gmKeys,[{label:'On-Time %',data:gmKeys.map(k=>((gMode[k].cnt-gMode[k].late)/gMode[k].cnt*100).toFixed(0)),backgroundColor:gmKeys.map((_,i)=>COLORS[i%COLORS.length]+'99'),borderRadius:4}]);
  }else if(gapEl){
    gapEl.innerHTML='<div class="kpi kpi-blue"><div class="kpi-label">Gap Analysis</div><div class="kpi-val">-</div><div class="kpi-sub">Needs ETA &amp; actual dates</div></div>';
  }

  // Delay table
  const dtb=document.getElementById('delayTbody');
  if(dtb)dtb.innerHTML=delayed.slice(0,25).map(r=>`<tr><td>${r.inv||'-'}</td><td>${r.sku||'-'}</td><td>${r.mode||'-'}</td><td style="color:#f472b6;font-size:10px">${r.cont||'-'}</td><td>${r.trk||'-'}</td><td>${r.eta||'-'}</td><td>${r.aeta||'Ongoing'}</td><td style="color:var(--rd);font-weight:700">${r.delayDays}d</td><td>${r.vnd||'-'}</td></tr>`).join('');

  // Delay Trends (flexible)
  renderDelayTrends();
}

function renderDelayTrends(){
  const dim=document.getElementById('dlDim')?.value||'jpnp',tg=document.getElementById('dlTime')?.value||'month';
  const delayed=[];
  FD.forEach(r=>{if(!r.eta)return;const eta=new Date(r.eta);if(isNaN(eta))return;let actual=null;if(r.aeta){actual=new Date(r.aeta);if(isNaN(actual))actual=null}if(!actual&&isTrans(r))actual=new Date();if(!actual)return;const days=Math.round((actual-eta)/86400000);if(days>0&&days<=365)delayed.push({...r,delayDays:days})});
  const dimFn={jpnp:r=>(r.cat||'').toUpperCase()==='JP'?'JP':'Non-JP',vnd:r=>r.vnd||'Unknown',svc:r=>isSea(r)?'Sea Freight':isAir(r)?'Air Freight':r.mode||'Other'};
  const getDim=dimFn[dim]||dimFn.jpnp;
  const dimVals={};delayed.forEach(r=>dimVals[getDim(r)]=(dimVals[getDim(r)]||0)+1);
  let dimKeys=Object.keys(dimVals).sort((a,b)=>dimVals[b]-dimVals[a]);
  if(dim==='vnd')dimKeys=dimKeys.slice(0,10);
  const tpSet=new Set();delayed.forEach(r=>{const _d=getRecDate(r);if(_d){const p=getTimePeriod(_d,tg);if(p)tpSet.add(p)}});
  const tKeys=[...tpSet].sort();
  const matrix={};dimKeys.forEach(dk=>{matrix[dk]={};tKeys.forEach(tk=>{matrix[dk][tk]={sum:0,cnt:0}})});
  delayed.forEach(r=>{const dk=getDim(r);if(!matrix[dk])return;const _d=getRecDate(r);const tp=_d?getTimePeriod(_d,tg):null;if(!tp||!matrix[dk][tp])return;matrix[dk][tp].sum+=r.delayDays;matrix[dk][tp].cnt++});
  const datasets=dimKeys.map((dk,i)=>{
    const color=COLORS[i%COLORS.length];
    return{label:dk.length>25?dk.substring(0,23)+'..':dk,data:tKeys.map(tk=>matrix[dk][tk].cnt?(matrix[dk][tk].sum/matrix[dk][tk].cnt).toFixed(1):0),borderColor:color,backgroundColor:color+'40',fill:false,tension:.3,pointRadius:3,borderWidth:2};
  });
  const titleEl=document.getElementById('dlTrendTitle');
  if(titleEl)titleEl.innerHTML='\u{1F4CA} Delay Trends: '+(dim==='jpnp'?'JP vs Non-JP':dim==='vnd'?'By Vendor':'By Service')+' ('+{month:'Monthly',quarter:'Quarterly',year:'Yearly'}[tg]+')';
  mkC2('chDelayTrend','line',tKeys,datasets,{scales:{x:{ticks:{color:'#64748b',font:{size:9},maxRotation:45},grid:{color:'rgba(51,65,85,.3)'}},y:{ticks:{color:'#64748b',font:{size:9}},grid:{color:'rgba(51,65,85,.3)'},beginAtZero:true,title:{display:true,text:'Avg Delay (days)',color:'#64748b'}}}});
  // Table
  const thead=document.getElementById('dlTrendThead'),tbody=document.getElementById('dlTrendTbody');
  if(thead)thead.innerHTML='<tr><th>Dimension</th>'+tKeys.map(t=>'<th>'+t+'</th>').join('')+'<th>Overall</th></tr>';
  if(tbody)tbody.innerHTML=dimKeys.map((dk,i)=>{
    const cells=tKeys.map(tk=>{const c=matrix[dk][tk];return'<td>'+(c.cnt?(c.sum/c.cnt).toFixed(1)+'d':'-')+'</td>'}).join('');
    const total=delayed.filter(r=>getDim(r)===dk);const oa=total.length?(total.reduce((s,r)=>s+r.delayDays,0)/total.length).toFixed(1)+'d':'-';
    return'<tr><td style="font-weight:600;color:'+COLORS[i%COLORS.length]+'">'+dk+'</td>'+cells+'<td style="font-weight:700">'+oa+'</td></tr>';
  }).join('');
}

// ============ TAB 3: OVERALL ANALYTICS ============
function renderOverall(){
  const n=FD.length,tv=FD.reduce((s,r)=>s+(parseVal(r.tval)),0),tq=FD.reduce((s,r)=>s+(parseVal(r.qty)),0);
  const trn=FD.filter(r=>isTrans(r)).length,rcv=FD.filter(r=>{const s=(r.fsts||'').toLowerCase();return s.includes('received')||s.includes('delivered')}).length;
  const air=FD.filter(r=>isAir(r)).length,sea=FD.filter(r=>isSea(r)).length;
  const road=FD.filter(r=>(r.mode||'').toLowerCase()==='road').length;
  const uv=new Set(FD.map(r=>r.vnd).filter(Boolean)).size;
  const uc=new Set(FD.map(r=>r.cont).filter(Boolean)).size;
  const el=document.getElementById('overallKpi');
  const ovVQ=VMODE==='qty'?tq.toLocaleString()+' pcs':fc(tv);
  if(el)el.innerHTML=
    `<div class="kpi kpi-blue clickable" onclick="showDetailPanel('All Filtered Shipments',FD)"><div class="kpi-label">Total Shipments</div><div class="kpi-val">${n.toLocaleString()}</div><div class="kpi-sub">${trn} transit &bull; ${rcv} received</div><div class="click-hint">Click to view</div></div>`+
    `<div class="kpi kpi-green"><div class="kpi-label">${VMODE==='qty'?'Total Quantity':'Total Value'}</div><div class="kpi-val">${ovVQ}</div><div class="kpi-sub">Avg ${VMODE==='qty'?Math.round(n?tq/n:0)+' pcs':fc(n?tv/n:0)} / shipment</div></div>`+
    `<div class="kpi kpi-orange"><div class="kpi-label">${VMODE==='qty'?'Total Value':'Total Quantity'}</div><div class="kpi-val">${VMODE==='qty'?fc(tv):tq.toLocaleString()}</div><div class="kpi-sub">${VMODE==='qty'?'Avg '+fc(n?tv/n:0):n?Math.round(tq/n):0+' pcs avg'}</div></div>`+
    `<div class="kpi kpi-cyan clickable" onclick="showKpiDetail('Air Shipments',r=>isAir(r))"><div class="kpi-label">Air</div><div class="kpi-val">${air}</div><div class="kpi-sub">${n?Math.round(air/n*100):0}%</div><div class="click-hint">Click to view</div></div>`+
    `<div class="kpi kpi-purple clickable" onclick="showKpiDetail('Sea Shipments',r=>isSea(r))"><div class="kpi-label">Sea</div><div class="kpi-val">${sea}</div><div class="kpi-sub">${n?Math.round(sea/n*100):0}%</div><div class="click-hint">Click to view</div></div>`+
    `<div class="kpi kpi-green"><div class="kpi-label">Vendors</div><div class="kpi-val">${uv}</div><div class="kpi-sub">Unique suppliers</div></div>`+
    `<div class="kpi kpi-red clickable" onclick="showKpiDetail('All Container Shipments',r=>!!r.cont)"><div class="kpi-label">Containers</div><div class="kpi-val">${uc}</div><div class="kpi-sub">${FD.filter(r=>r.cont).length} shipments</div><div class="click-hint">Click to view</div></div>`;

  // Monthly overview — stacked JP/LSP toggle
  const mm={};FD.forEach(r=>{const _d=getRecDate(r);if(!_d)return;const k=_d.substring(0,7);const c=(r.cat||'').toUpperCase();const isJP=c==='JP'||c.includes('JP SAMPLE');if(!mm[k])mm[k]={c:0,v:0,q:0,jpC:0,jpV:0,jpQ:0,njpC:0,njpV:0,njpQ:0};mm[k].c++;mm[k].v+=parseVal(r.tval);mm[k].q+=parseVal(r.qty);if(isJP){mm[k].jpC++;mm[k].jpV+=parseVal(r.tval);mm[k].jpQ+=parseVal(r.qty)}else{mm[k].njpC++;mm[k].njpV+=parseVal(r.tval);mm[k].njpQ+=parseVal(r.qty)}});
  const mk=Object.keys(mm).sort();
  const mLbl=mk.map(k=>{const[y,m]=k.split('-');return MNAMES[parseInt(m)-1]+" '"+y.slice(2)});
  const mLabel=VMODE==='val'?'Value ('+CUR+')':VMODE==='qty'?'Quantity':'Count';
  const stk=document.getElementById('ovStackToggle')?.checked;
  if(stk){
    const jpD=mk.map(k=>VMODE==='val'?Math.round(mm[k].jpV*CRATE[CUR]):VMODE==='qty'?mm[k].jpQ:mm[k].jpC);
    const njpD=mk.map(k=>VMODE==='val'?Math.round(mm[k].njpV*CRATE[CUR]):VMODE==='qty'?mm[k].njpQ:mm[k].njpC);
    if(charts['chOvMonth']){charts['chOvMonth'].destroy();delete charts['chOvMonth']}
    const ctx=document.getElementById('chOvMonth');if(ctx)charts['chOvMonth']=new Chart(ctx,{type:'bar',data:{labels:mLbl,datasets:[
      {label:'JP',data:jpD,backgroundColor:'rgba(59,130,246,.7)',borderRadius:3},
      {label:'NJP/LSP',data:njpD,backgroundColor:'rgba(139,92,246,.7)',borderRadius:3}
    ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,position:'top',labels:{color:'#94a3b8',boxWidth:10,padding:6,font:{size:10}}}},scales:{x:{stacked:true,ticks:{color:'#64748b',font:{size:9},maxRotation:45},grid:{color:'rgba(51,65,85,.3)'}},y:{stacked:true,ticks:{color:'#64748b',font:{size:9}},grid:{color:'rgba(51,65,85,.3)'},beginAtZero:true}}}});
  }else{
    const mData=mk.map(k=>VMODE==='val'?Math.round(mm[k].v*CRATE[CUR]):VMODE==='qty'?mm[k].q:mm[k].c);
    mkC('chOvMonth','bar',mLbl,[{label:mLabel,data:mData,backgroundColor:'rgba(59,130,246,.6)',borderRadius:4}]);
  }

  // By mode
  const mo={};FD.forEach(r=>{const k=r.mode||'Unknown';if(!mo[k])mo[k]={c:0,v:0};mo[k].c++;mo[k].v+=parseVal(r.tval)});
  const mok=Object.keys(mo).sort((a,b)=>mo[b].c-mo[a].c).slice(0,10);
  mkC('chOvMode','doughnut',mok,[{data:mok.map(k=>VMODE==='val'?Math.round(mo[k].v*CRATE[CUR]):mo[k].c),backgroundColor:COLORS,borderWidth:0}],true);

  // By location
  const lm={};FD.forEach(r=>{const k=r.loc||'Unknown';if(!lm[k])lm[k]={c:0,v:0};lm[k].c++;lm[k].v+=parseVal(r.tval)});
  const lk=Object.keys(lm).sort((a,b)=>lm[b].c-lm[a].c);
  mkC('chOvLoc','bar',lk,[{label:mLabel,data:lk.map(k=>VMODE==='val'?Math.round(lm[k].v*CRATE[CUR]):lm[k].c),backgroundColor:'rgba(16,185,129,.6)',borderRadius:4}]);

  // Status distribution
  const sm={};FD.forEach(r=>{const k=r.fsts||'Unknown';sm[k]=(sm[k]||0)+1});
  const sk=Object.keys(sm).sort((a,b)=>sm[b]-sm[a]);
  mkC('chOvSts','doughnut',sk,[{data:sk.map(k=>sm[k]),backgroundColor:COLORS,borderWidth:0}],true);

  // By category
  const ca={};FD.forEach(r=>{const k=r.cat||'Unknown';if(!ca[k])ca[k]={c:0,v:0};ca[k].c++;ca[k].v+=parseVal(r.tval)});
  const cak=Object.keys(ca).sort((a,b)=>ca[b].c-ca[a].c);
  mkC('chOvCat','doughnut',cak,[{data:cak.map(k=>ca[k].c),backgroundColor:COLORS,borderWidth:0}],true);

  // By agent
  const ag={};FD.forEach(r=>{const k=r.agt||'Unknown';ag[k]=(ag[k]||0)+1});
  const agk=Object.keys(ag).sort((a,b)=>ag[b]-ag[a]).slice(0,10);
  mkC('chOvAgt','bar',agk.map(k=>k.length>16?k.substring(0,14)+'..':k),[{label:'Shipments',data:agk.map(k=>ag[k]),backgroundColor:agk.map((_,i)=>COLORS[i%COLORS.length]+'99'),borderRadius:4}]);

  // --- CONTAINER ANALYSIS ---
  renderContainers();

  // --- JP vs LSP ---
  renderJPvsLSP();
}

function renderContainers(){
  const contEl=document.getElementById('contSection');
  const contRecs=FD.filter(r=>r.cont);
  if(!contRecs.length){if(contEl)contEl.style.display='none';return}
  if(contEl)contEl.style.display='block';
  // Group containers
  const cg={};
  contRecs.forEach(r=>{
    const c=r.cont;
    if(!cg[c])cg[c]={cnt:0,val:0,qty:0,modes:new Set(),vendors:new Set(),cats:new Set(),eta:null,dt:null,intransit:false,trk:null,sts:null};
    cg[c].cnt++;cg[c].val+=parseVal(r.tval);cg[c].qty+=parseVal(r.qty);
    if(r.mode)cg[c].modes.add(r.mode);if(r.vnd)cg[c].vendors.add(r.vnd);if(r.cat)cg[c].cats.add(r.cat);
    if(r.eta&&(!cg[c].eta||r.eta>cg[c].eta))cg[c].eta=r.eta;
    if(r.dt&&(!cg[c].dt||r.dt>cg[c].dt))cg[c].dt=r.dt;
    if(isTrans(r))cg[c].intransit=true;
    if(r.trk&&!cg[c].trk)cg[c].trk=r.trk;if(r.fsts)cg[c].sts=r.fsts;
  });
  const contKeys=Object.keys(cg);const totalConts=contKeys.length;
  const inTransitConts=contKeys.filter(k=>cg[k].intransit).length;
  const totalContVal=contKeys.reduce((s,k)=>s+cg[k].val,0);
  const avgPerCont=totalConts?contRecs.length/totalConts:0;
  const maxCont=contKeys.length?contKeys.reduce((mx,k)=>cg[k].cnt>cg[mx].cnt?k:mx,contKeys[0]):'';
  // KPIs
  const ckpi=document.getElementById('contKpi');
  if(ckpi)ckpi.innerHTML=
    `<div class="kpi kpi-cyan"><div class="kpi-label">Total Containers</div><div class="kpi-val">${totalConts}</div><div class="kpi-sub">${inTransitConts} in-transit</div></div>`+
    `<div class="kpi kpi-green"><div class="kpi-label">Container Value</div><div class="kpi-val">${fc(totalContVal)}</div><div class="kpi-sub">${fc(totalConts?totalContVal/totalConts:0)} avg</div></div>`+
    `<div class="kpi kpi-orange"><div class="kpi-label">Avg Shipments/Cont</div><div class="kpi-val">${avgPerCont.toFixed(1)}</div><div class="kpi-sub">shipments per container</div></div>`+
    `<div class="kpi kpi-purple"><div class="kpi-label">Largest Container</div><div class="kpi-val">${maxCont?cg[maxCont].cnt:0}</div><div class="kpi-sub">${maxCont?(maxCont.length>20?maxCont.substring(0,18)+'..':maxCont):'-'}</div></div>`;
  // Monthly container count & value (MoM) with JP/NJP breakdown
  const contFilt=document.getElementById('contJpFilter')?.value||'all';
  let filtRecs=contRecs;
  if(contFilt==='jp')filtRecs=contRecs.filter(r=>{const c=(r.cat||'').toUpperCase();return c==='JP'||c.includes('JP SAMPLE')});
  else if(contFilt==='njp')filtRecs=contRecs.filter(r=>{const c=(r.cat||'').toUpperCase();return c!=='JP'&&!c.includes('JP SAMPLE')});
  const momC={};
  filtRecs.forEach(r=>{const _d=getRecDate(r);if(!_d)return;const m=_d.substring(0,7);if(!momC[m])momC[m]={conts:new Set(),val:0,qty:0,ship:0};momC[m].conts.add(r.cont);momC[m].val+=parseVal(r.tval);momC[m].qty+=parseVal(r.qty);momC[m].ship++});
  const cmk=Object.keys(momC).sort();
  const cmLbl=cmk.map(k=>{const[y,m]=k.split('-');return MNAMES[parseInt(m)-1]+" '"+y.slice(2)});
  mkC2('chContBar','bar',cmLbl,[
    {label:'Container Count',data:cmk.map(k=>momC[k].conts.size),backgroundColor:'rgba(6,182,212,.6)',borderRadius:4,yAxisID:'y'},
    {label:'Shipments',data:cmk.map(k=>momC[k].ship),type:'line',borderColor:'#f59e0b',fill:false,tension:.3,pointRadius:2,yAxisID:'y1'}
  ],{scales:{x:{ticks:{color:'#64748b',font:{size:9},maxRotation:45},grid:{color:'rgba(51,65,85,.3)'}},y:{position:'left',ticks:{color:'#64748b',font:{size:9}},grid:{color:'rgba(51,65,85,.3)'},beginAtZero:true,title:{display:true,text:'Containers',color:'#64748b'}},y1:{position:'right',ticks:{color:'#64748b',font:{size:9}},grid:{drawOnChartArea:false},beginAtZero:true,title:{display:true,text:'Shipments',color:'#64748b'}}}});
  mkC2('chContVal','bar',cmLbl,[
    {label:'Container Value ('+CUR+')',data:cmk.map(k=>Math.round(momC[k].val*CRATE[CUR])),backgroundColor:'rgba(16,185,129,.6)',borderRadius:4,yAxisID:'y'},
    {label:'Avg Value/Cont',data:cmk.map(k=>{const sz=momC[k].conts.size;return sz?Math.round(momC[k].val*CRATE[CUR]/sz):0}),type:'line',borderColor:'#a78bfa',fill:false,tension:.3,pointRadius:2,yAxisID:'y1'}
  ],{scales:{x:{ticks:{color:'#64748b',font:{size:9},maxRotation:45},grid:{color:'rgba(51,65,85,.3)'}},y:{position:'left',ticks:{color:'#64748b',font:{size:9}},grid:{color:'rgba(51,65,85,.3)'},beginAtZero:true,title:{display:true,text:'Total Value',color:'#64748b'}},y1:{position:'right',ticks:{color:'#64748b',font:{size:9}},grid:{drawOnChartArea:false},beginAtZero:true,title:{display:true,text:'Avg/Container',color:'#64748b'}}}});
  // Container detail table
  const tblConts=contKeys.sort((a,b)=>cg[b].cnt-cg[a].cnt);
  const ctb=document.getElementById('contTbody');
  if(ctb)ctb.innerHTML=tblConts.map(c=>{
    const g=cg[c];const dl=g.eta?daysUntil(g.eta):'-';
    return`<tr><td title="${c}" style="font-weight:700;color:var(--ac)">${c}</td><td>${g.cnt}</td><td>${[...g.modes].join(', ')}</td><td>${[...g.cats].join(', ')}</td><td style="text-align:right">${fcFull(g.val)}</td><td>${g.qty}</td><td>${[...g.vendors].map(v=>v.length>14?v.substring(0,12)+'..':v).join(', ')}</td><td>${g.eta||'-'}</td><td style="font-weight:700;color:${typeof dl==='number'?(dl<0?'var(--rd)':dl<=7?'var(--or)':'var(--gn)'):'var(--t2)'}">${typeof dl==='number'?(dl<0?dl+'d':dl+'d'):dl}</td><td><span class="sb ${g.intransit?'sb-trn':'sb-rcv'}">${g.intransit?'In Transit':'Received'}</span></td></tr>`;
  }).join('');
}

function renderJPvsLSP(){
  const jp=FD.filter(r=>(r.cat||'').toUpperCase()==='JP'),lsp=FD.filter(r=>(r.cat||'').toUpperCase()==='LSP');
  const jpS=FD.filter(r=>(r.cat||'').toUpperCase()==='JP SAMPLE'),lspS=FD.filter(r=>(r.cat||'').toLowerCase().includes('lsp sample'));
  const jpV=jp.reduce((s,r)=>s+(parseVal(r.tval)),0),lspV=lsp.reduce((s,r)=>s+(parseVal(r.tval)),0);
  const jpQ=jp.reduce((s,r)=>s+(parseVal(r.qty)),0),lspQ=lsp.reduce((s,r)=>s+(parseVal(r.qty)),0);
  const mv=VMODE==='val';
  const el=document.getElementById('jpLspKpi');
  if(el)el.innerHTML=
    `<div class="kpi kpi-blue"><div class="kpi-label">JP</div><div class="kpi-val">${jp.length.toLocaleString()}</div><div class="kpi-sub">+${jpS.length} samples</div></div>`+
    `<div class="kpi kpi-purple"><div class="kpi-label">LSP</div><div class="kpi-val">${lsp.length.toLocaleString()}</div><div class="kpi-sub">+${lspS.length} samples</div></div>`+
    `<div class="kpi kpi-green"><div class="kpi-label">JP ${mv?'Value':'Qty'}</div><div class="kpi-val">${mv?fc(jpV):jpQ.toLocaleString()}</div><div class="kpi-sub">${jp.length?'Avg '+(mv?fc(jpV/jp.length):Math.round(jpQ/jp.length)):'-'}</div></div>`+
    `<div class="kpi kpi-orange"><div class="kpi-label">LSP ${mv?'Value':'Qty'}</div><div class="kpi-val">${mv?fc(lspV):lspQ.toLocaleString()}</div><div class="kpi-sub">${lsp.length?'Avg '+(mv?fc(lspV/lsp.length):Math.round(lspQ/lsp.length)):'-'}</div></div>`;
  mkC('chJpVal','bar',['JP','LSP','JP Sample','LSP Sample'],[{label:'Value ('+CUR+')',
    data:[jpV,lspV,jpS.reduce((s,r)=>s+(parseVal(r.tval)),0),lspS.reduce((s,r)=>s+(parseVal(r.tval)),0)].map(v=>Math.round(v*CRATE[CUR])),
    backgroundColor:['rgba(59,130,246,.7)','rgba(139,92,246,.7)','rgba(59,130,246,.3)','rgba(139,92,246,.3)'],borderRadius:5}]);
  mkC('chJpQty','bar',['JP','LSP','JP Sample','LSP Sample'],[{label:'Quantity',
    data:[jpQ,lspQ,jpS.reduce((s,r)=>s+(parseVal(r.qty)),0),lspS.reduce((s,r)=>s+(parseVal(r.qty)),0)],
    backgroundColor:['rgba(16,185,129,.7)','rgba(245,158,11,.7)','rgba(16,185,129,.3)','rgba(245,158,11,.3)'],borderRadius:5}]);
  const jpM={},lspM={};
  jp.forEach(r=>{const _d=getRecDate(r);if(_d){const m=_d.substring(0,7);jpM[m]=(jpM[m]||0)+1}});
  lsp.forEach(r=>{const _d=getRecDate(r);if(_d){const m=_d.substring(0,7);lspM[m]=(lspM[m]||0)+1}});
  const am=[...new Set([...Object.keys(jpM),...Object.keys(lspM)])].sort();
  mkC('chJpTrend','line',am,[
    {label:'JP',data:am.map(m=>jpM[m]||0),borderColor:'#3b82f6',backgroundColor:'rgba(59,130,246,.1)',fill:true,tension:.3,pointRadius:2},
    {label:'LSP',data:am.map(m=>lspM[m]||0),borderColor:'#8b5cf6',backgroundColor:'rgba(139,92,246,.1)',fill:true,tension:.3,pointRadius:2}]);
  const jv={},lv={};jp.forEach(r=>{const v=r.vnd||'?';jv[v]=(jv[v]||0)+1});lsp.forEach(r=>{const v=r.vnd||'?';lv[v]=(lv[v]||0)+1});
  const tv2=[...new Set([...Object.entries(jv).sort((a,b)=>b[1]-a[1]).slice(0,5).map(v=>v[0]),...Object.entries(lv).sort((a,b)=>b[1]-a[1]).slice(0,5).map(v=>v[0])])];
  mkC('chJpVnd','bar',tv2.map(v=>v.length>18?v.substring(0,16)+'..':v),[
    {label:'JP',data:tv2.map(v=>jv[v]||0),backgroundColor:'rgba(59,130,246,.6)',borderRadius:3},
    {label:'LSP',data:tv2.map(v=>lv[v]||0),backgroundColor:'rgba(139,92,246,.6)',borderRadius:3}]);
}

// ============ TAB 4: TRENDS & FORECASTING ============
function renderTrendTab(){
  renderTrends();
  renderLeadTime();
}

function renderTrends(){
  const dim=document.getElementById('trDim')?.value||'cat',metric=document.getElementById('trMetric')?.value||'count';
  const tg=document.getElementById('trTime')?.value||'month',ct=document.getElementById('trChart')?.value||'line';
  const dimLabel={cat:'Category',loc:'Location',vnd:'Vendor',mode:'Mode',fy:'FY',fsts:'Status',agt:'Agent',cont:'Container'};
  const metricLabel={count:'Shipment Count',tval:'Value ('+CUR+')',qty:'Quantity',avgval:'Avg Value ('+CUR+')',contcount:'Container Count'};
  const titleEl=document.getElementById('trendTitle');
  if(titleEl)titleEl.innerHTML='\u{1F4C8} '+(dim==='cont'?'Container Count':dimLabel[dim]+' - '+(metricLabel[metric]||metric))+' ('+{month:'Monthly',quarter:'Quarterly',year:'Yearly'}[tg]+')';
  // Special handling for Container dimension: show container count per time period by category
  if(dim==='cont'){
    const tpSet=new Set();FD.forEach(r=>{const _d=getRecDate(r);if(_d){const p=getTimePeriod(_d,tg);if(p)tpSet.add(p)}});
    const tKeys=[...tpSet].sort();
    // Build container count by time period, split by category
    const catVals={};FD.filter(r=>r.cont).forEach(r=>{const c=(r.cat||'').toUpperCase();const grp=c==='JP'||c.includes('JP SAMPLE')?'JP':'NJP/LSP';catVals[grp]=1});
    const catKeys=Object.keys(catVals).sort();
    const cMatrix={};catKeys.forEach(ck=>{cMatrix[ck]={};tKeys.forEach(tk=>{cMatrix[ck][tk]=new Set()})});
    const totalByTP={};tKeys.forEach(tk=>{totalByTP[tk]=new Set()});
    FD.filter(r=>r.cont&&getRecDate(r)).forEach(r=>{
      const tp=getTimePeriod(getRecDate(r),tg);if(!tp)return;
      const c=(r.cat||'').toUpperCase();const grp=c==='JP'||c.includes('JP SAMPLE')?'JP':'NJP/LSP';
      if(cMatrix[grp]&&cMatrix[grp][tp])cMatrix[grp][tp].add(r.cont);
      if(totalByTP[tp])totalByTP[tp].add(r.cont);
    });
    const datasets=catKeys.map((ck,i)=>{
      const color=COLORS[i%COLORS.length];const isLine=ct==='line';
      return{label:ck,data:tKeys.map(tk=>cMatrix[ck][tk]?cMatrix[ck][tk].size:0),backgroundColor:ct==='stackedbar'?color:color+'99',borderColor:color,borderWidth:isLine?2:1,borderRadius:isLine?0:3,fill:false,tension:.3,pointRadius:isLine?3:0};
    });
    const chartType=ct==='stackedbar'?'bar':ct;
    if(charts['chTrend']){charts['chTrend'].destroy();delete charts['chTrend']}
    const ctx=document.getElementById('chTrend');if(ctx)charts['chTrend']=new Chart(ctx,{type:chartType,data:{labels:tKeys,datasets},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,position:'top',labels:{color:'#94a3b8',boxWidth:10,padding:6,font:{size:10}}}},scales:{x:{stacked:ct==='stackedbar',ticks:{color:'#64748b',font:{size:9},maxRotation:45},grid:{color:'rgba(51,65,85,.3)'}},y:{stacked:ct==='stackedbar',ticks:{color:'#64748b',font:{size:9}},grid:{color:'rgba(51,65,85,.3)'},beginAtZero:true,title:{display:true,text:'Container Count',color:'#64748b'}}}}});
    const totals=catKeys.map(ck=>tKeys.reduce((s,tk)=>s+(cMatrix[ck][tk]?cMatrix[ck][tk].size:0),0));
    mkC('chTrendBar','bar',catKeys,[{label:'Container Count',data:totals,backgroundColor:catKeys.map((_,i)=>COLORS[i%COLORS.length]),borderRadius:4}]);
    mkC('chTrendPie','doughnut',catKeys,[{data:totals,backgroundColor:COLORS,borderWidth:0}],true);
    const thead=document.getElementById('trendThead'),tbody=document.getElementById('trendTbody');
    if(thead)thead.innerHTML='<tr><th>Category</th>'+tKeys.map(t=>'<th>'+t+'</th>').join('')+'<th>Total</th></tr>';
    if(tbody)tbody.innerHTML=catKeys.map((ck,i)=>{
      const cells=tKeys.map(tk=>'<td>'+(cMatrix[ck][tk]?cMatrix[ck][tk].size:0)+'</td>').join('');
      return'<tr><td style="font-weight:600;color:'+COLORS[i%COLORS.length]+'">'+ck+'</td>'+cells+'<td style="font-weight:700">'+totals[i]+'</td></tr>';
    }).join('');
    // Add total row
    if(tbody){const totalRow='<tr style="font-weight:700;background:rgba(59,130,246,.05)"><td>Total</td>'+tKeys.map(tk=>'<td>'+(totalByTP[tk]?totalByTP[tk].size:0)+'</td>').join('')+'<td>'+new Set(FD.filter(r=>r.cont).map(r=>r.cont)).size+'</td></tr>';tbody.innerHTML+=totalRow}
    return;
  }
  const dimVals={};FD.forEach(r=>{const k=r[dim]||'Unknown';dimVals[k]=(dimVals[k]||0)+1});
  let dimKeys=Object.keys(dimVals).sort((a,b)=>dimVals[b]-dimVals[a]);
  if(['vnd','agt'].includes(dim))dimKeys=dimKeys.slice(0,10);
  const tpSet=new Set();FD.forEach(r=>{const _d=getRecDate(r);if(_d){const p=getTimePeriod(_d,tg);if(p)tpSet.add(p)}});
  const tKeys=[...tpSet].sort();
  const matrix={};dimKeys.forEach(dk=>{matrix[dk]={};tKeys.forEach(tk=>{matrix[dk][tk]={count:0,tval:0,qty:0,conts:new Set()}})});
  FD.forEach(r=>{const dk=r[dim]||'Unknown';if(!matrix[dk])return;const _d=getRecDate(r);const tp=_d?getTimePeriod(_d,tg):null;if(!tp||!matrix[dk][tp])return;matrix[dk][tp].count++;matrix[dk][tp].tval+=parseVal(r.tval);matrix[dk][tp].qty+=parseVal(r.qty);if(r.cont)matrix[dk][tp].conts.add(r.cont)});
  const effMetric=metric==='contcount'?'contcount':metric;
  const datasets=dimKeys.map((dk,i)=>{
    const color=COLORS[i%COLORS.length];
    const data=tKeys.map(tk=>{const c=matrix[dk][tk];if(effMetric==='count')return c.count;if(effMetric==='tval')return Math.round(c.tval*CRATE[CUR]);if(effMetric==='qty')return c.qty;if(effMetric==='avgval')return c.count?Math.round(c.tval*CRATE[CUR]/c.count):0;if(effMetric==='contcount')return c.conts.size;return 0});
    const isLine=ct==='line';
    return{label:dk.length>25?dk.substring(0,23)+'..':dk,data,backgroundColor:ct==='stackedbar'?color:color+'99',borderColor:color,borderWidth:isLine?2:1,borderRadius:isLine?0:3,fill:false,tension:.3,pointRadius:isLine?3:0};
  });
  const chartType=ct==='stackedbar'?'bar':ct;
  if(charts['chTrend']){charts['chTrend'].destroy();delete charts['chTrend']}
  charts['chTrend']=new Chart(document.getElementById('chTrend'),{type:chartType,data:{labels:tKeys,datasets},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,position:'top',labels:{color:'#94a3b8',boxWidth:10,padding:6,font:{size:10}}}},
      scales:{x:{stacked:ct==='stackedbar',ticks:{color:'#64748b',font:{size:9},maxRotation:45},grid:{color:'rgba(51,65,85,.3)'}},
        y:{stacked:ct==='stackedbar',ticks:{color:'#64748b',font:{size:9}},grid:{color:'rgba(51,65,85,.3)'},beginAtZero:true}}}});
  const totals=dimKeys.map(dk=>{let val=0;if(effMetric==='contcount'){const allConts=new Set();tKeys.forEach(tk=>{matrix[dk][tk].conts.forEach(c=>allConts.add(c))});return allConts.size}tKeys.forEach(tk=>{const c=matrix[dk][tk];if(effMetric==='count')val+=c.count;else if(effMetric==='tval')val+=c.tval*CRATE[CUR];else if(effMetric==='qty')val+=c.qty;else if(effMetric==='avgval'){const tc=Object.values(matrix[dk]).reduce((s,x)=>s+x.count,0);const tt=Object.values(matrix[dk]).reduce((s,x)=>s+x.tval,0);val=tc?tt*CRATE[CUR]/tc:0}});return Math.round(val)});
  mkC('chTrendBar','bar',dimKeys.map(k=>k.length>18?k.substring(0,16)+'..':k),[{label:metricLabel[effMetric]||effMetric,data:totals,backgroundColor:dimKeys.map((_,i)=>COLORS[i%COLORS.length]),borderRadius:4}]);
  mkC('chTrendPie','doughnut',dimKeys.map(k=>k.length>18?k.substring(0,16)+'..':k),[{data:totals,backgroundColor:COLORS,borderWidth:0}],true);
  const thead=document.getElementById('trendThead'),tbody=document.getElementById('trendTbody');
  const isVal=effMetric==='tval'||effMetric==='avgval';
  if(thead)thead.innerHTML='<tr><th>'+dimLabel[dim]+'</th>'+tKeys.map(t=>'<th>'+t+'</th>').join('')+'<th>Total</th></tr>';
  if(tbody)tbody.innerHTML=dimKeys.map((dk,i)=>{
    const cells=tKeys.map(tk=>{const c=matrix[dk][tk];let v=effMetric==='count'?c.count:effMetric==='tval'?Math.round(c.tval*CRATE[CUR]):effMetric==='qty'?c.qty:effMetric==='contcount'?c.conts.size:c.count?Math.round(c.tval*CRATE[CUR]/c.count):0;return'<td>'+(isVal?CSYM[CUR]+v.toLocaleString():v.toLocaleString())+'</td>'}).join('');
    return'<tr><td style="font-weight:600;color:'+COLORS[i%COLORS.length]+'">'+dk+'</td>'+cells+'<td style="font-weight:700">'+(isVal?CSYM[CUR]+totals[i].toLocaleString():totals[i].toLocaleString())+'</td></tr>';
  }).join('');
}

function renderLeadTime(){
  const ltRecords=[];
  FD.forEach(r=>{if(!r.dt)return;const arr=r.aeta||r.eta;if(!arr)return;const dt=new Date(r.dt),a=new Date(arr);if(isNaN(dt)||isNaN(a))return;const ld=Math.round((a-dt)/86400000);if(ld>0&&ld<=365)ltRecords.push({...r,leadDays:ld,isActual:!!r.aeta})});
  ltRecords.sort((a,b)=>b.leadDays-a.leadDays);
  const actualLT=ltRecords.filter(r=>r.isActual),estLT=ltRecords.filter(r=>!r.isActual);
  const totalWithLT=ltRecords.length;
  const avgLT=totalWithLT?ltRecords.reduce((s,r)=>s+r.leadDays,0)/totalWithLT:0;
  const avgActual=actualLT.length?actualLT.reduce((s,r)=>s+r.leadDays,0)/actualLT.length:0;
  const medianLT=totalWithLT?ltRecords[Math.floor(totalWithLT/2)].leadDays:0;
  const airLT=ltRecords.filter(r=>isAir(r)),seaLT=ltRecords.filter(r=>isSea(r));
  const avgAir=airLT.length?airLT.reduce((s,r)=>s+r.leadDays,0)/airLT.length:0;
  const avgSea=seaLT.length?seaLT.reduce((s,r)=>s+r.leadDays,0)/seaLT.length:0;
  const el=document.getElementById('ltKpi');
  if(el)el.innerHTML=
    `<div class="kpi kpi-blue"><div class="kpi-label">Lead Time Data</div><div class="kpi-val">${totalWithLT.toLocaleString()}</div><div class="kpi-sub">${actualLT.length} actual &bull; ${estLT.length} est.</div></div>`+
    `<div class="kpi kpi-green"><div class="kpi-label">Avg Lead Time</div><div class="kpi-val">${avgLT.toFixed(1)}d</div><div class="kpi-sub">Actual: ${avgActual.toFixed(1)}d</div></div>`+
    `<div class="kpi kpi-cyan"><div class="kpi-label">Air Avg</div><div class="kpi-val">${avgAir.toFixed(1)}d</div><div class="kpi-sub">${airLT.length} shipments</div></div>`+
    `<div class="kpi kpi-purple"><div class="kpi-label">Sea Avg</div><div class="kpi-val">${avgSea.toFixed(1)}d</div><div class="kpi-sub">${seaLT.length} shipments</div></div>`+
    `<div class="kpi kpi-orange"><div class="kpi-label">Median</div><div class="kpi-val">${medianLT}d</div><div class="kpi-sub">50th pctl</div></div>`+
    `<div class="kpi kpi-red"><div class="kpi-label">Longest</div><div class="kpi-val">${totalWithLT?ltRecords[0].leadDays:0}d</div><div class="kpi-sub">${totalWithLT?ltRecords[0].mode||'':''}</div></div>`;
  // Monthly
  const mm={};ltRecords.forEach(r=>{const _d=getRecDate(r);if(!_d)return;const m=_d.substring(0,7),t=isSea(r)?'sea':isAir(r)?'air':'other';if(!mm[m])mm[m]={sum:0,cnt:0,airS:0,airC:0,seaS:0,seaC:0};mm[m].sum+=r.leadDays;mm[m].cnt++;if(t==='air'){mm[m].airS+=r.leadDays;mm[m].airC++}else if(t==='sea'){mm[m].seaS+=r.leadDays;mm[m].seaC++}});
  const mKeys=Object.keys(mm).sort();
  const mLbl=mKeys.map(k=>{const[y,m]=k.split('-');return MNAMES[parseInt(m)-1]+" '"+y.slice(2)});
  mkC2('chLTMonth','bar',mLbl,[
    {label:'Air Avg',data:mKeys.map(m=>mm[m].airC?(mm[m].airS/mm[m].airC).toFixed(1):0),backgroundColor:'rgba(59,130,246,.6)',borderRadius:3,yAxisID:'y'},
    {label:'Sea Avg',data:mKeys.map(m=>mm[m].seaC?(mm[m].seaS/mm[m].seaC).toFixed(1):0),backgroundColor:'rgba(34,211,238,.6)',borderRadius:3,yAxisID:'y'},
    {label:'Overall',data:mKeys.map(m=>(mm[m].sum/mm[m].cnt).toFixed(1)),type:'line',borderColor:'#f59e0b',fill:false,tension:.3,pointRadius:2,yAxisID:'y'}
  ],{scales:{x:{ticks:{color:'#64748b',font:{size:9},maxRotation:45},grid:{color:'rgba(51,65,85,.3)'}},y:{ticks:{color:'#64748b',font:{size:9}},grid:{color:'rgba(51,65,85,.3)'},beginAtZero:true,title:{display:true,text:'Days',color:'#64748b'}}}});
  // By mode
  const mo={};ltRecords.forEach(r=>{const m=r.mode||'Unknown';if(!mo[m])mo[m]={sum:0,cnt:0};mo[m].sum+=r.leadDays;mo[m].cnt++});
  const moE=Object.entries(mo).sort((a,b)=>b[1].cnt-a[1].cnt).slice(0,10);
  mkC2('chLTMode','bar',moE.map(e=>e[0].length>16?e[0].substring(0,14)+'..':e[0]),[
    {label:'Avg Lead Time',data:moE.map(e=>(e[1].sum/e[1].cnt).toFixed(1)),backgroundColor:moE.map((_,i)=>COLORS[i%COLORS.length]+'99'),borderRadius:4,yAxisID:'y'},
    {label:'Count',data:moE.map(e=>e[1].cnt),type:'line',borderColor:'#94a3b8',pointRadius:3,borderWidth:1.5,fill:false,yAxisID:'y1'}
  ],{scales:{x:{ticks:{color:'#64748b',font:{size:9},maxRotation:45},grid:{color:'rgba(51,65,85,.3)'}},y:{position:'left',ticks:{color:'#64748b',font:{size:9}},grid:{color:'rgba(51,65,85,.3)'},beginAtZero:true,title:{display:true,text:'Avg Days',color:'#64748b'}},y1:{position:'right',ticks:{color:'#64748b',font:{size:9}},grid:{drawOnChartArea:false},beginAtZero:true,title:{display:true,text:'Count',color:'#64748b'}}}});
  // Distribution
  const bkt={'1-3d':0,'4-7d':0,'8-14d':0,'15-30d':0,'31-60d':0,'60+d':0};
  ltRecords.forEach(r=>{if(r.leadDays<=3)bkt['1-3d']++;else if(r.leadDays<=7)bkt['4-7d']++;else if(r.leadDays<=14)bkt['8-14d']++;else if(r.leadDays<=30)bkt['15-30d']++;else if(r.leadDays<=60)bkt['31-60d']++;else bkt['60+d']++});
  mkC('chLTDist','bar',Object.keys(bkt),[{label:'Shipments',data:Object.values(bkt),backgroundColor:['rgba(16,185,129,.6)','rgba(96,165,250,.6)','rgba(245,158,11,.6)','rgba(239,68,68,.6)','rgba(236,72,153,.6)','rgba(139,92,246,.6)'],borderRadius:4}]);
  // By vendor
  const vd={};ltRecords.forEach(r=>{const v=r.vnd||'Unknown';if(!vd[v])vd[v]={sum:0,cnt:0};vd[v].sum+=r.leadDays;vd[v].cnt++});
  const vdE=Object.entries(vd).sort((a,b)=>b[1].cnt-a[1].cnt).slice(0,10);
  mkC('chLTVendor','bar',vdE.map(e=>e[0].length>16?e[0].substring(0,14)+'..':e[0]),[{label:'Avg Lead Time (d)',data:vdE.map(e=>(e[1].sum/e[1].cnt).toFixed(1)),backgroundColor:'rgba(168,85,247,.6)',borderRadius:4}]);

  // Customs
  const custRecords=FD.filter(r=>r.cdt);
  if(custRecords.length){
    const custDelayed=[];
    custRecords.forEach(r=>{if(!r.cdt||!r.cclr)return;const cdt=new Date(r.cdt),cclr=new Date(r.cclr);if(isNaN(cdt)||isNaN(cclr))return;const cd=Math.round((cclr-cdt)/86400000);if(cd>0&&cd<=365)custDelayed.push({...r,custDays:cd})});
    const custAvg=custDelayed.length?custDelayed.reduce((s,r)=>s+r.custDays,0)/custDelayed.length:0;
    const ckpi=document.getElementById('customsKpi');
    if(ckpi)ckpi.innerHTML=
      `<div class="kpi kpi-purple"><div class="kpi-label">Customs Data</div><div class="kpi-val">${custRecords.length}</div><div class="kpi-sub">Records with cdt</div></div>`+
      `<div class="kpi kpi-orange"><div class="kpi-label">Avg Customs Time</div><div class="kpi-val">${custAvg.toFixed(1)}d</div><div class="kpi-sub">Days to clear</div></div>`;
    const cm={};custDelayed.forEach(r=>{if(!r.cdt)return;const m=r.cdt.substring(0,7);if(!cm[m])cm[m]={sum:0,cnt:0};cm[m].sum+=r.custDays;cm[m].cnt++});
    const cKeys=Object.keys(cm).sort();
    const cLbl=cKeys.map(k=>{const[y,m]=k.split('-');return MNAMES[parseInt(m)-1]+" '"+y.slice(2)});
    mkC('chCustoms','bar',cLbl,[{label:'Avg Customs Time (d)',data:cKeys.map(m=>(cm[m].sum/cm[m].cnt).toFixed(1)),backgroundColor:'rgba(236,72,153,.6)',borderRadius:4}]);
    const ce=document.getElementById('customsEmpty');if(ce)ce.style.display='none';
  }else{
    const ckpi=document.getElementById('customsKpi');if(ckpi)ckpi.innerHTML='';
    const ce=document.getElementById('customsEmpty');if(ce)ce.style.display='block';
  }
  // Table
  const ltb=document.getElementById('ltTbody');
  if(ltb)ltb.innerHTML=ltRecords.slice(0,30).map(r=>`<tr><td>${r.dt||'-'}</td><td>${r.inv||'-'}</td><td>${r.mode||'-'}</td><td><span class="k-badge ${catBadgeCls(r.cat)}">${r.cat||'-'}</span></td><td style="color:#f472b6;font-size:10px">${r.cont||'-'}</td><td>${r.vnd||'-'}</td><td>${r.eta||'-'}</td><td>${r.aeta||'-'}</td><td style="font-weight:700">${r.leadDays}d</td><td><span class="sb ${r.isActual?'sb-rcv':'sb-trn'}">${r.isActual?'Actual':'Est.'}</span></td></tr>`).join('');
}

// ============ TAB 5: ALL SHIPMENTS TABLE ============
function renderTbl(){
  const q=(document.getElementById('tblSearch')?.value||'').toLowerCase();
  let data=FD;
  if(q)data=data.filter(r=>(r.inv||'').toLowerCase().includes(q)||(r.sku+'').toLowerCase().includes(q)||(r.trk||'').toLowerCase().includes(q)||(r.vnd||'').toLowerCase().includes(q)||(r.loc||'').toLowerCase().includes(q)||(r.cat||'').toLowerCase().includes(q)||(r.cont||'').toLowerCase().includes(q));
  data=[...data].sort((a,b)=>{let va=a[tblSort.key]||'',vb=b[tblSort.key]||'';if(tblSort.key==='qty'||tblSort.key==='tval'){va=parseFloat(va)||0;vb=parseFloat(vb)||0}return tblSort.asc?(va<vb?-1:va>vb?1:0):(va>vb?-1:va<vb?1:0)});
  const cntEl=document.getElementById('tblCount');if(cntEl)cntEl.textContent=data.length+' records';
  const pages=Math.ceil(data.length/PG);if(tblPage>=pages)tblPage=Math.max(0,pages-1);
  const sl=data.slice(tblPage*PG,(tblPage+1)*PG);
  const tb=document.getElementById('mainTbody');
  if(tb)tb.innerHTML=sl.map(r=>`<tr><td>${r.dt||'-'}</td><td>${r.inv||'-'}</td><td>${r.loc||'-'}</td><td>${r.mode||'-'}</td><td style="color:#f472b6;font-size:10px" title="${r.cont||''}">${r.cont||'-'}</td><td>${r.trk?'<a href="'+trkUrl(r.trk,r.mode)+'" target="_blank" style="color:var(--ac);text-decoration:none">'+r.trk+'</a>':'-'}</td><td>${r.sku||'-'}</td><td>${r.qty||'-'}</td><td style="text-align:right">${r.tval?fcFull(parseVal(r.tval)):'-'}</td><td>${r.cat||'-'}</td><td>${stsBadge(r.fsts)}</td><td>${r.vnd||'-'}</td><td>${r.eta||'-'}</td></tr>`).join('');
  const pag=document.getElementById('mainPag');if(!pag||pages<=1){if(pag)pag.innerHTML='';return}
  let ph='<button '+(tblPage===0?'disabled':'')+' onclick="tblPage=0;renderTbl()">\u00AB</button>';
  ph+='<button '+(tblPage===0?'disabled':'')+' onclick="tblPage--;renderTbl()">\u2039</button>';
  for(let i=Math.max(0,tblPage-2);i<=Math.min(pages-1,tblPage+2);i++)ph+='<button class="'+(i===tblPage?'act':'')+'" onclick="tblPage='+i+';renderTbl()">'+(i+1)+'</button>';
  ph+='<span class="pag-info">'+(tblPage+1)+'/'+pages+'</span>';
  ph+='<button '+(tblPage>=pages-1?'disabled':'')+' onclick="tblPage++;renderTbl()">\u203A</button>';
  ph+='<button '+(tblPage>=pages-1?'disabled':'')+' onclick="tblPage='+(pages-1)+';renderTbl()">\u00BB</button>';
  pag.innerHTML=ph;
}
function sortTbl(k){if(tblSort.key===k)tblSort.asc=!tblSort.asc;else{tblSort.key=k;tblSort.asc=true}renderTbl()}

// ============ CSV EXPORT ============
function exportCSV(){
  const h=['Date','Invoice','Location','Mode','Tracking','SKU','Qty','Value','Freight','TotalValue','Status','FinalStatus','ETA','Category','Vendor','FY','PO','Container','Agent'];
  const k=['dt','inv','loc','mode','trk','sku','qty','val','frt','tval','sts','fsts','eta','cat','vnd','fy','po','cont','agt'];
  let csv=h.join(',')+'\n';
  FD.forEach(r=>{csv+=k.map(x=>{let v=(r[x]||'').toString().replace(/"/g,'""');return v.includes(',')?'"'+v+'"':v}).join(',')+'\n'});
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download='shipments_'+new Date().toISOString().slice(0,10)+'.csv';a.click();
}

// ============ TABS ============
function switchTab(n){
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',i===n));
  document.querySelectorAll('.tab-body').forEach((t,i)=>t.classList.toggle('active',i===n));
}

// ============ INIT ============
window.addEventListener('DOMContentLoaded',()=>setTimeout(loadData,100));
