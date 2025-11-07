/****************************************************************
 * Merimac VDO.Ninja Bridge — Fixed Browser Autoplay (Nov 2025)
 ****************************************************************/
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = 8080;
const PUBLIC_HOST = "https://bridge.merimac.ca";
const VDO = "https://vdo.ninja";
const ROOM = "MERIMAC";

const INACTIVITY_MS = 8_000;  // Clear inactive slots after 8 seconds
const GRACE_MS = 5_000;        // 5 second grace period on initial connection

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SLOTS = {};
for(let i=1;i<=50;i++)SLOTS[i]=null;
const deviceIndex = new Map();

let MAX_SLOTS = 5; // Default to 5, configurable via API

function now(){return Date.now();}
function firstFree(){for(let i=1;i<=MAX_SLOTS;i++) if(!SLOTS[i]) return i; return null;}
function claim(streamId,label){
  const id=String(streamId).replace(/[^a-zA-Z0-9]/g,"");
  if(deviceIndex.has(id)){const n=deviceIndex.get(id);SLOTS[n].last=now();return n;}
  const n=firstFree(); if(!n)return null;
  SLOTS[n]={streamId:id,label:label||"cam",since:now(),last:now(),grace:now()+GRACE_MS};
  deviceIndex.set(id,n); return n;
}
function clearSlot(n){if(SLOTS[n]){deviceIndex.delete(SLOTS[n].streamId);SLOTS[n]=null;}}
function clearById(id){const n=deviceIndex.get(id);if(!n)return;deviceIndex.delete(id);SLOTS[n]=null;return true;}

app.get("/api/state",(r,s)=>s.json({slots:SLOTS,maxSlots:MAX_SLOTS}));
app.post("/api/config",(r,s)=>{
  const {maxSlots}=r.body||{};
  if(maxSlots&&maxSlots>=1&&maxSlots<=50){
    MAX_SLOTS=maxSlots;
    s.json({ok:true,maxSlots:MAX_SLOTS});
  }else{
    s.json({ok:false,error:"maxSlots must be between 1 and 50"});
  }
});
app.post("/api/claim",(r,s)=>{
  const {streamId,label}=r.body||{};
  if(!streamId)return s.json({ok:false});
  const n=claim(streamId,label); if(!n)return s.json({ok:false,error:"full"});
  io.emit("state",{slots:SLOTS});
  s.json({ok:true,slot:n});
});
app.post("/api/heartbeat",(r,s)=>{
  const id=(r.body?.streamId||"").replace(/[^a-zA-Z0-9]/g,"");
  const n=deviceIndex.get(id);
  if(n&&SLOTS[n]){SLOTS[n].last=now();io.emit("state",{slots:SLOTS});}
  s.json({ok:true});
});
app.post("/api/leave",(r,s)=>{
  const id=(r.body?.streamId||"").replace(/[^a-zA-Z0-9]/g,"");
  const c=clearById(id); if(c)io.emit("state",{slots:SLOTS}); s.json({ok:!!c});
});
app.post("/api/clear/:n",(r,s)=>{
  const n=+r.params.n; clearSlot(n); io.emit("state",{slots:SLOTS}); s.json({ok:true});
});
app.get("/health",(r,s)=>s.json({ok:true,active:Object.values(SLOTS).filter(Boolean).length}));

app.get("/api/system",async(r,s)=>{
  const {exec}=require("child_process");
  const util=require("util");
  const execAsync=util.promisify(exec);

  try{
    const info={};

    // CPU usage
    try{
      const {stdout:top}=await execAsync("top -bn1 | grep 'Cpu(s)'");
      const match=top.match(/(\d+\.\d+)\s*id/);
      if(match)info.cpuUsage=(100-parseFloat(match[1])).toFixed(1)+'%';
      else info.cpuUsage='N/A';
    }catch(e){info.cpuUsage='N/A';}

    // Memory usage
    try{
      const {stdout:mem}=await execAsync("free -m | grep Mem");
      const parts=mem.split(/\s+/);
      const total=parseInt(parts[1]);
      const used=parseInt(parts[2]);
      info.memUsage=`${used}MB / ${total}MB`;
      info.memPercent=((used/total)*100).toFixed(1)+'%';
    }catch(e){info.memUsage='N/A';info.memPercent='N/A';}

    // Temperature (Raspberry Pi specific)
    try{
      const {stdout:temp}=await execAsync("vcgencmd measure_temp");
      info.temperature=temp.replace("temp=","").trim();
    }catch(e){
      try{
        const {stdout:temp2}=await execAsync("cat /sys/class/thermal/thermal_zone0/temp");
        info.temperature=(parseInt(temp2)/1000).toFixed(1)+"°C";
      }catch(e2){info.temperature='N/A';}
    }

    // Uptime
    try{
      const {stdout:uptime}=await execAsync("uptime -p");
      info.uptime=uptime.replace("up ","").trim();
    }catch(e){info.uptime='N/A';}

    // Disk usage
    try{
      const {stdout:disk}=await execAsync("df -h / | tail -1");
      const parts=disk.split(/\s+/);
      info.diskUsage=`${parts[2]} / ${parts[1]}`;
      info.diskPercent=parts[4];
      info.diskAvailable=parts[3];
    }catch(e){info.diskUsage='N/A';info.diskPercent='N/A';info.diskAvailable='N/A';}

    // Network usage
    try{
      const {stdout:net}=await execAsync("cat /proc/net/dev | grep -E 'eth0|wlan0|enp|wlp' | head -1");
      if(net){
        const parts=net.trim().split(/\s+/);
        const rxBytes=parseInt(parts[1]);
        const txBytes=parseInt(parts[9]);
        const rxGB=(rxBytes/(1024*1024*1024)).toFixed(2);
        const txGB=(txBytes/(1024*1024*1024)).toFixed(2);
        info.networkRx=rxGB+'GB';
        info.networkTx=txGB+'GB';
      }else{
        info.networkRx='N/A';
        info.networkTx='N/A';
      }
    }catch(e){info.networkRx='N/A';info.networkTx='N/A';}

    s.json(info);
  }catch(e){
    s.json({error:e.message});
  }
});

app.get("/join",(req,res)=>{
  res.send(`<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Join Camera</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
    color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .container{text-align:center;max-width:400px;width:100%}
  h1{font-size:2.5em;margin-bottom:0.3em;font-weight:700}
  .subtitle{font-size:1.1em;opacity:0.9;margin-bottom:2em}
  #go{background:#fff;color:#667eea;border:none;border-radius:50px;
    font-size:1.3em;font-weight:600;padding:18px 50px;cursor:pointer;
    box-shadow:0 10px 30px rgba(0,0,0,0.3);transition:all 0.3s ease;
    width:100%;max-width:300px;touch-action:manipulation}
  #go:hover{transform:translateY(-2px);box-shadow:0 15px 40px rgba(0,0,0,0.4)}
  #go:active{transform:translateY(0)}
  #msg{margin-top:2em;font-size:1em;opacity:0.8;line-height:1.6}
  .status{display:inline-block;background:rgba(255,255,255,0.2);
    padding:8px 20px;border-radius:20px;margin-top:1em}
</style>
</head><body>
<div class="container">
  <h1>📹 Merimac Live</h1>
  <p class="subtitle">Join the show as a camera</p>
  <button id="go">Join Now</button>
  <p id="msg">Tap the button above to get started</p>
</div>
<script>
function id(){let i=localStorage.getItem("sid");if(!i){i=Math.random().toString(36).slice(2,12);localStorage.setItem("sid",i);}return i;}
const streamId=id();
async function post(u,b){return fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});}
setInterval(()=>post("/api/heartbeat",{streamId},true),5000);
window.addEventListener("pagehide",()=>post("/api/leave",{streamId},true));
document.getElementById("go").onclick=async()=>{
  const w=window.open("about:blank","_blank");
  const r=await post("/api/claim",{streamId});
  const j=await r.json(); if(!j.ok){w.close();return alert("All slots full");}
  const n=j.slot;
  w.location="${VDO}/?push="+encodeURIComponent(streamId)
             +"&label=cam"+n+"&bitrate=2500&codec=h264&autostart&webcam&muted";
  document.getElementById("msg").innerHTML='<div class="status">✅ Connected as Camera '+n+'</div><br>Keep this page open during the show';
};
</script></body></html>`);
});

app.get("/slot/:n",(req,res)=>{
  const n=+req.params.n;
  res.send(`<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Slot ${n}</title>
<style>
html,body{margin:0;height:100%;background:#000;overflow:hidden}
iframe{width:100%;height:100%;border:0}
#overlay{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);
  display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:999}
#overlay div{background:#fff;color:#000;padding:20px 40px;border-radius:8px;font-family:system-ui;font-size:18px}
#overlay:hover div{background:#f0f0f0}
.waiting{color:#999;display:flex;align-items:center;justify-content:center;height:100%;font-family:system-ui}
</style>
</head><body>
<div id="wrap" style="height:100%"><div class="waiting">Waiting for camera ${n}…</div></div>
<script src="/socket.io/socket.io.js"></script>
<script>
const slot=${n};const wrap=document.getElementById("wrap");let cur=null;let needsClick=false;
function isOBS(){return /OBS|obslocal|obsbrowser/i.test(navigator.userAgent);}
function render(id){
  if(id===cur)return;cur=id;wrap.innerHTML="";
  if(!id){wrap.innerHTML='<div class="waiting">Waiting for camera ${n}…</div>';return;}

  let url="${VDO}/?view="+encodeURIComponent(id)
          +"&cleanoutput=1&stats=0&scene&autostart=1&coverview";
  if(!isOBS())url+="&muted=1";

  const f=document.createElement("iframe");
  f.allow="autoplay; camera; microphone; fullscreen; display-capture; encrypted-media; picture-in-picture";
  f.setAttribute("allowfullscreen","");
  f.src=url;

  wrap.appendChild(f);

  // Add click-to-play overlay for browsers (not OBS)
  if(!isOBS()){
    needsClick=true;
    const ov=document.createElement("div");
    ov.id="overlay";
    ov.innerHTML='<div>▶ Click to Play Video</div>';
    ov.onclick=()=>{
      ov.remove();
      needsClick=false;
      // Reload iframe to trigger autoplay after user interaction
      f.src=f.src;
    };
    wrap.appendChild(ov);
  }
}
async function poll(){
  try{
    const j=await fetch("/api/state").then(r=>r.json());
    const s=j.slots[String(slot)];
    render(s?s.streamId:null);
  }catch(e){console.error("Poll error:",e);}
}
poll();
const io_=io();
io_.on("state",poll);
setInterval(poll,2000);  // Poll every 2 seconds for faster updates
</script></body></html>`);
});

app.get("/control",async(req,res)=>{
  const qr=await QRCode.toDataURL(`${PUBLIC_HOST}/join`);
  const rows=Object.entries(SLOTS).map(([n,s])=>{
    const status=s?'<span class="badge active">Active</span>':'<span class="badge empty">Empty</span>';
    const id=s?s.streamId:'-';
    const slotUrl=`${PUBLIC_HOST}/slot/${n}`;
    return `<tr class="${s?'occupied':''}">
    <td><strong>${n}</strong></td>
    <td>${status}</td>
    <td class="stream-id">${id}</td>
    <td><a href="/slot/${n}" target="_blank" class="btn-link">View</a> <button onclick="copySlotUrl('${slotUrl}')" class="btn-copy">Copy Link</button></td>
    <td><button onclick="clearSlot(${n})" class="btn-clear" ${!s?'disabled':''}>Clear</button></td></tr>`;
  }).join("");
  res.send(`<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Control Dashboard</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0f0f23;color:#e0e0e0;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    padding:20px;min-height:100vh}
  .header{text-align:center;margin-bottom:40px;position:relative;min-height:80px;display:flex;align-items:center;justify-content:center}
  .header-title{flex:1;max-width:800px}
  .system-compact{position:absolute;top:0;right:0;text-align:right;font-size:0.85em;color:#888;line-height:1.6;white-space:nowrap}
  .system-compact div{margin-bottom:3px}
  @media(max-width:1024px){.system-compact{font-size:0.75em}}
  @media(max-width:768px){.header{flex-direction:column;min-height:auto}.system-compact{position:static;margin-top:15px;text-align:center;font-size:0.85em}}
  h1{color:#fff;font-size:2em;margin-bottom:10px}
  .subtitle{color:#888;font-size:1em;margin-bottom:30px}
  .container{max-width:1200px;margin:0 auto}
  .grid{display:grid;grid-template-columns:1fr 2fr;gap:30px;margin-bottom:30px}
  @media(max-width:768px){.grid{grid-template-columns:1fr}}
  .card{background:#1a1a2e;border-radius:12px;padding:25px;box-shadow:0 4px 20px rgba(0,0,0,0.3)}
  .qr-card{text-align:center}
  .qr-card img{border-radius:8px;background:#fff;padding:15px;margin-bottom:15px}
  .qr-card .link-container{margin:15px auto;max-width:280px}
  .qr-card a{color:#667eea;text-decoration:none;font-weight:500;display:block;
    word-wrap:break-word;overflow-wrap:break-word;line-height:1.4}
  .qr-card a:hover{text-decoration:underline}
  table{width:100%;border-collapse:collapse}
  th{background:#252540;color:#fff;padding:12px;text-align:left;font-weight:600;border-bottom:2px solid #667eea}
  td{padding:12px;border-bottom:1px solid #2a2a3e}
  tr.occupied{background:#1e1e35}
  tr:hover{background:#252540}
  .stream-id{font-family:monospace;font-size:0.9em;color:#888}
  .badge{display:inline-block;padding:4px 12px;border-radius:12px;font-size:0.85em;font-weight:600}
  .badge.active{background:#10b981;color:#fff}
  .badge.empty{background:#374151;color:#9ca3af}
  .btn-link{color:#667eea;text-decoration:none;font-weight:500;padding:6px 16px;
    border-radius:6px;background:rgba(102,126,234,0.1);display:inline-block;transition:all 0.2s}
  .btn-link:hover{background:rgba(102,126,234,0.2);transform:translateY(-1px)}
  .btn-clear{background:#ef4444;color:#fff;border:none;padding:6px 16px;border-radius:6px;
    cursor:pointer;font-weight:500;transition:all 0.2s}
  .btn-clear:hover:not(:disabled){background:#dc2626;transform:translateY(-1px)}
  .btn-clear:disabled{background:#374151;cursor:not-allowed;opacity:0.5}
  .stats{display:flex;justify-content:space-around;margin-top:20px;padding-top:20px;border-top:1px solid #2a2a3e}
  .stat{text-align:center}
  .stat-value{font-size:2em;font-weight:700;color:#667eea}
  .stat-label{color:#888;font-size:0.9em;margin-top:5px}
  .settings-box{margin-top:20px;padding-top:20px;border-top:1px solid #2a2a3e}
  .settings-box h3{margin-bottom:15px;font-size:1em}
  .settings-row{display:flex;gap:15px;align-items:center;margin-bottom:15px}
  .settings-row label{color:#e0e0e0;font-weight:500;flex:1}
  .settings-row input{background:#252540;border:1px solid #667eea;color:#fff;
    padding:8px 12px;border-radius:6px;width:100px;font-size:1em}
  .settings-row input:focus{outline:none;border-color:#764ba2}
  .btn-apply{background:#667eea;color:#fff;border:none;padding:8px 20px;
    border-radius:6px;cursor:pointer;font-weight:500;transition:all 0.2s;width:100%}
  .btn-apply:hover{background:#764ba2;transform:translateY(-1px)}
  .btn-copy{background:#667eea;color:#fff;border:none;padding:6px 12px;border-radius:6px;
    cursor:pointer;font-weight:500;transition:all 0.2s;font-size:0.85em}
  .btn-copy:hover{background:#764ba2;transform:translateY(-1px)}
  .btn-copy:active{background:#5a67d8}
</style>
</head><body>
<div class="container">
  <div class="header">
    <div class="system-compact" id="system-info-compact">
      <div>CPU: <span id="cpu">-</span></div>
      <div>RAM: <span id="ram">-</span></div>
      <div>Temp: <span id="temp">-</span></div>
      <div>Disk: <span id="disk">-</span> (<span id="disk-avail">-</span> free)</div>
      <div>Net: ↓<span id="net-rx">-</span> ↑<span id="net-tx">-</span></div>
      <div>Uptime: <span id="uptime">-</span></div>
    </div>
    <div class="header-title">
      <h1>Merimac Video Ninja Bridge</h1>
      <p class="subtitle">Live camera management dashboard</p>
    </div>
  </div>
  <div class="grid">
    <div class="card qr-card">
      <h3 style="margin-bottom:15px">Join Code</h3>
      <img src="${qr}" width="200">
      <div class="link-container">
        <a href="${PUBLIC_HOST}/join" target="_blank">${PUBLIC_HOST}/join</a>
      </div>
      <div class="stats">
        <div class="stat">
          <div class="stat-value" id="active-count">0</div>
          <div class="stat-label">Active</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="total-slots">5</div>
          <div class="stat-label">Total Slots</div>
        </div>
      </div>
      <div class="settings-box">
        <h3>Slot Configuration</h3>
        <div class="settings-row">
          <label>Total Slots:</label>
          <input type="number" id="total-slots-input" value="5" min="1" max="50">
        </div>
        <button class="btn-apply" onclick="applySettings()">Apply</button>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:15px">Camera Slots</h3>
      <table id="t"><tr><th>Slot</th><th>Status</th><th>Stream ID</th><th>Slot Link</th><th>Action</th></tr>${rows}</table>
    </div>
  </div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
let maxSlots=5;

async function loadSettings(){
  const j=await fetch('/api/state').then(r=>r.json());
  maxSlots=j.maxSlots||5;
  document.getElementById('total-slots-input').value=maxSlots;
  document.getElementById('total-slots').textContent=maxSlots;
}

async function applySettings(){
  const total=parseInt(document.getElementById('total-slots-input').value);
  if(total<1||total>50){alert('Total slots must be between 1 and 50');return;}
  const res=await fetch('/api/config',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({maxSlots:total})
  });
  const j=await res.json();
  if(j.ok){
    maxSlots=j.maxSlots;
    document.getElementById('total-slots').textContent=maxSlots;
    refresh();
  }else{
    alert(j.error||'Failed to update settings');
  }
}

function copySlotUrl(url){
  navigator.clipboard.writeText(url).then(()=>{
    // Could add visual feedback here
  }).catch(err=>console.error('Copy failed:',err));
}

async function clearSlot(n){await fetch('/api/clear/'+n,{method:'POST'});refresh();}

async function refresh(){
  const j=await fetch('/api/state').then(r=>r.json());
  maxSlots=j.maxSlots||maxSlots;
  let h='<tr><th>Slot</th><th>Status</th><th>Stream ID</th><th>Slot Link</th><th>Action</th></tr>';
  let activeCount=0;
  for(let i=1;i<=maxSlots;i++){
    const s=j.slots[i];
    if(s)activeCount++;
    const status=s?'<span class="badge active">Active</span>':'<span class="badge empty">Empty</span>';
    const id=s?s.streamId:'-';
    const rowClass=s?'occupied':'';
    const disabled=s?'':'disabled';
    const slotUrl='${PUBLIC_HOST}/slot/'+i;
    h+=\`<tr class="\${rowClass}">
    <td><strong>\${i}</strong></td>
    <td>\${status}</td>
    <td class="stream-id">\${id}</td>
    <td><a href="/slot/\${i}" target="_blank" class="btn-link">View</a> <button onclick="copySlotUrl('\${slotUrl}')" class="btn-copy">Copy Link</button></td>
    <td><button onclick="clearSlot(\${i})" class="btn-clear" \${disabled}>Clear</button></td></tr>\`;
  }
  document.getElementById('t').innerHTML=h;
  document.getElementById('active-count').textContent=activeCount;
}

async function updateSystemInfo(){
  try{
    const info=await fetch('/api/system').then(r=>r.json());
    document.getElementById('cpu').textContent=info.cpuUsage||'N/A';
    document.getElementById('ram').textContent=info.memPercent||'N/A';
    document.getElementById('temp').textContent=info.temperature||'N/A';
    document.getElementById('disk').textContent=info.diskPercent||'N/A';
    document.getElementById('disk-avail').textContent=info.diskAvailable||'N/A';
    document.getElementById('net-rx').textContent=info.networkRx||'N/A';
    document.getElementById('net-tx').textContent=info.networkTx||'N/A';
    document.getElementById('uptime').textContent=info.uptime||'N/A';
  }catch(e){
    console.error('Failed to fetch system info:',e);
  }
}

loadSettings();
io().on('state',refresh);
updateSystemInfo();
setInterval(updateSystemInfo,5000); // Update system info every 5 seconds
</script></body></html>`);
});

setInterval(()=>{
  const t=now();let ch=false;
  for(let i=1;i<=50;i++){
    const s=SLOTS[i];if(!s)continue;
    if(t-s.last>INACTIVITY_MS && t>s.grace){deviceIndex.delete(s.streamId);SLOTS[i]=null;ch=true;}
  }
  if(ch)io.emit("state",{slots:SLOTS});
},3000);

server.listen(PORT,()=>console.log("Bridge listening :"+PORT));
