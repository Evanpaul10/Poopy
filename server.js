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

app.get("/api/network",async(r,s)=>{
  const {exec}=require("child_process");
  const util=require("util");
  const execAsync=util.promisify(exec);

  try{
    const devices=[];
    let debugInfo={};

    // First, ping the network to populate ARP cache
    console.log('Starting network scan for 192.168.8.x...');
    try{
      // Try fping first (fastest)
      const fpingResult=await execAsync("fping -a -g 192.168.8.0/24 2>/dev/null",{timeout:8000}).catch(e=>null);
      if(fpingResult){
        console.log('fping completed successfully');
        debugInfo.scanMethod='fping';
      }else{
        console.log('fping not available, using arp-scan...');
        // Try arp-scan (requires root, but very reliable)
        const arpscanResult=await execAsync("sudo arp-scan -l --interface=eth0 2>/dev/null || sudo arp-scan -l --interface=wlan0 2>/dev/null",{timeout:8000}).catch(e=>null);
        if(arpscanResult && arpscanResult.stdout){
          console.log('arp-scan completed successfully');
          debugInfo.scanMethod='arp-scan';
          debugInfo.arpscanOutput=arpscanResult.stdout;
        }else{
          console.log('arp-scan not available, using ping sweep...');
          debugInfo.scanMethod='ping-sweep';
        }
      }
    }catch(e){
      console.error('Network scan error:',e.message);
      debugInfo.scanError=e.message;
    }

    // Now read ARP table
    try{
      const {stdout:arp}=await execAsync("ip neigh show 2>/dev/null || arp -a 2>/dev/null");
      console.log('ARP table output:',arp);
      debugInfo.arpTable=arp;

      const lines=arp.split('\n');
      for(const line of lines){
        if(!line.trim())continue;

        let ip, mac;

        // Try ip neigh format: "192.168.8.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE"
        let match=line.match(/(\d+\.\d+\.\d+\.\d+)\s+dev\s+\S+\s+lladdr\s+([0-9a-f:]+)/i);
        if(match){
          ip=match[1];
          mac=match[2].toUpperCase();
        }else{
          // Try arp -a format: "? (192.168.8.1) at aa:bb:cc:dd:ee:ff [ether] on eth0"
          match=line.match(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:]+)/i);
          if(match){
            ip=match[1];
            mac=match[2].toUpperCase();
          }else{
            // Try simpler ip neigh format: "192.168.8.1 lladdr aa:bb:cc:dd:ee:ff"
            match=line.match(/(\d+\.\d+\.\d+\.\d+)\s+lladdr\s+([0-9a-f:]+)/i);
            if(match){
              ip=match[1];
              mac=match[2].toUpperCase();
            }
          }
        }

        if(ip && mac && ip.startsWith('192.168.8.') && mac!=='00:00:00:00:00:00' && !mac.includes('INCOMPLETE')){
          // Check if already added
          if(!devices.find(d=>d.ip===ip)){
            // Try to get hostname
            let hostname='Unknown';
            try{
              const {stdout:host}=await execAsync(`timeout 1 host ${ip} 2>/dev/null || getent hosts ${ip} 2>/dev/null`);
              if(host){
                const hostMatch=host.match(/pointer\s+(.+?)\./) || host.match(/\S+\s+(\S+)/);
                if(hostMatch)hostname=hostMatch[1];
              }
            }catch(e){}
            devices.push({ip,mac,hostname});
            console.log(`Found device: ${ip} - ${mac} - ${hostname}`);
          }
        }
      }
    }catch(e){
      console.error('ARP table read error:',e.message);
      debugInfo.arpError=e.message;
    }

    console.log(`Network scan complete. Found ${devices.length} devices.`);
    s.json({devices,debug:debugInfo});
  }catch(e){
    console.error('Network API error:',e);
    s.json({error:e.message,devices:[],debug:{error:e.message}});
  }
});

app.get("/api/logs",async(r,s)=>{
  const {exec}=require("child_process");
  const util=require("util");
  const execAsync=util.promisify(exec);

  try{
    const logs={};

    // Service logs
    try{
      const {stdout:service}=await execAsync("journalctl -u merimac-bridge -n 100 --no-pager");
      logs.service=service;
    }catch(e){logs.service='Failed to fetch service logs';}

    // System logs (recent errors)
    try{
      const {stdout:system}=await execAsync("journalctl -p err -n 50 --no-pager");
      logs.system=system;
    }catch(e){logs.system='Failed to fetch system logs';}

    s.json(logs);
  }catch(e){
    s.json({error:e.message});
  }
});

// Shared layout function for dashboard pages
function dashboardLayout(pageName,content){
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${pageName} - Merimac Bridge</title>
<script src="/socket.io/socket.io.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0f0f23;color:#e0e0e0;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex}
  .sidebar{width:220px;background:#1a1a2e;height:100vh;position:fixed;left:0;top:0;padding:20px;box-shadow:2px 0 10px rgba(0,0,0,0.3)}
  .sidebar-title{color:#fff;font-size:1.3em;font-weight:700;margin-bottom:30px;padding-bottom:15px;border-bottom:2px solid #667eea}
  .nav-item{display:block;padding:12px 15px;margin-bottom:8px;border-radius:8px;color:#e0e0e0;text-decoration:none;transition:all 0.2s}
  .nav-item:hover{background:#252540;transform:translateX(5px)}
  .nav-item.active{background:#667eea;color:#fff}
  .main-content{margin-left:220px;flex:1;padding:20px;min-height:100vh}
  @media(max-width:768px){.sidebar{width:100%;height:auto;position:static;padding:15px}.main-content{margin-left:0}}
  .header{text-align:center;margin-bottom:40px;position:relative;min-height:80px;display:flex;align-items:center;justify-content:center}
  .header-title{flex:1;max-width:800px}
  .system-compact{position:absolute;top:0;right:0;text-align:right;font-size:0.85em;color:#888;line-height:1.6;white-space:nowrap}
  .system-compact div{margin-bottom:3px}
  @media(max-width:1024px){.system-compact{font-size:0.75em}}
  @media(max-width:768px){.header{flex-direction:column;min-height:auto}.system-compact{position:static;margin-top:15px;text-align:center;font-size:0.85em}}
  h1{color:#fff;font-size:2em;margin-bottom:10px}
  .subtitle{color:#888;font-size:1em;margin-bottom:30px}
  .container{max-width:1400px;margin:0 auto}
  .grid{display:grid;grid-template-columns:1fr 2fr;gap:30px;margin-bottom:30px}
  @media(max-width:768px){.grid{grid-template-columns:1fr}}
  .card{background:#1a1a2e;border-radius:12px;padding:25px;box-shadow:0 4px 20px rgba(0,0,0,0.3);margin-bottom:20px}
  .qr-card{text-align:center}
  .qr-card img{border-radius:8px;background:#fff;padding:15px;margin-bottom:15px}
  .qr-card .link-container{margin:15px auto;max-width:280px}
  .qr-card a{color:#667eea;text-decoration:none;font-weight:500;display:block;word-wrap:break-word;overflow-wrap:break-word;line-height:1.4}
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
  .btn-link{color:#667eea;text-decoration:none;font-weight:500;padding:6px 16px;border-radius:6px;background:rgba(102,126,234,0.1);display:inline-block;transition:all 0.2s}
  .btn-link:hover{background:rgba(102,126,234,0.2);transform:translateY(-1px)}
  .btn-clear{background:#ef4444;color:#fff;border:none;padding:6px 16px;border-radius:6px;cursor:pointer;font-weight:500;transition:all 0.2s}
  .btn-clear:hover:not(:disabled){background:#dc2626;transform:translateY(-1px)}
  .btn-clear:disabled{background:#374151;cursor:not-allowed;opacity:0.5}
  .btn-copy{background:#667eea;color:#fff;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-weight:500;transition:all 0.2s;font-size:0.85em}
  .btn-copy:hover{background:#764ba2;transform:translateY(-1px)}
  .btn-copy:active{background:#5a67d8}
  .btn-refresh{background:#10b981;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-weight:500;transition:all 0.2s}
  .btn-refresh:hover{background:#059669;transform:translateY(-1px)}
  .stats{display:flex;justify-content:space-around;margin-top:20px;padding-top:20px;border-top:1px solid #2a2a3e}
  .stat{text-align:center}
  .stat-value{font-size:2em;font-weight:700;color:#667eea}
  .stat-label{color:#888;font-size:0.9em;margin-top:5px}
  .settings-box{margin-top:20px;padding-top:20px;border-top:1px solid #2a2a3e}
  .settings-box h3{margin-bottom:15px;font-size:1em}
  .settings-row{display:flex;gap:15px;align-items:center;margin-bottom:15px}
  .settings-row label{color:#e0e0e0;font-weight:500;flex:1}
  .settings-row input{background:#252540;border:1px solid #667eea;color:#fff;padding:8px 12px;border-radius:6px;width:100px;font-size:1em}
  .settings-row input:focus{outline:none;border-color:#764ba2}
  .btn-apply{background:#667eea;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-weight:500;transition:all 0.2s;width:100%}
  .btn-apply:hover{background:#764ba2;transform:translateY(-1px)}
  .log-container{background:#0a0a15;padding:15px;border-radius:8px;font-family:monospace;font-size:0.85em;max-height:500px;overflow-y:auto;white-space:pre-wrap;word-wrap:break-word}
  .guide-section{margin-bottom:30px}
  .guide-section h3{color:#667eea;margin-bottom:15px}
  .guide-section p{line-height:1.8;margin-bottom:10px}
  .guide-section ol{margin-left:20px;line-height:2}
  .guide-section code{background:#252540;padding:2px 8px;border-radius:4px;color:#10b981}
</style>
</head><body>
<div class="sidebar">
  <div class="sidebar-title">Merimac Bridge</div>
  <a href="/control" class="nav-item ${pageName==='Control'?'active':''}">Control</a>
  <a href="/network" class="nav-item ${pageName==='Network'?'active':''}">Network</a>
  <a href="/debug" class="nav-item ${pageName==='Debug'?'active':''}">Debug</a>
  <a href="/guide" class="nav-item ${pageName==='Guide'?'active':''}">Guide</a>
</div>
<div class="main-content">
  <div class="container">
    ${content}
  </div>
</div>
</body></html>`;
}

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
setInterval(()=>post("/api/heartbeat",{streamId},true),2000);
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
  // Only show rows up to MAX_SLOTS
  const rows=[];
  for(let i=1;i<=MAX_SLOTS;i++){
    const s=SLOTS[i];
    const status=s?'<span class="badge active">Active</span>':'<span class="badge empty">Empty</span>';
    const id=s?s.streamId:'-';
    const slotUrl=`${PUBLIC_HOST}/slot/${i}`;
    rows.push(`<tr class="${s?'occupied':''}">
    <td><strong>${i}</strong></td>
    <td>${status}</td>
    <td class="stream-id">${id}</td>
    <td><a href="/slot/${i}" target="_blank" class="btn-link">View</a> <button onclick="copySlotUrl('${slotUrl}')" class="btn-copy">Copy Link</button></td>
    <td><button onclick="clearSlot(${i})" class="btn-clear" ${!s?'disabled':''}>Clear</button></td></tr>`);
  }
  const rowsHtml=rows.join("");

  const content=`
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
            <div class="stat-value" id="total-slots">${MAX_SLOTS}</div>
            <div class="stat-label">Total Slots</div>
          </div>
        </div>
        <div class="settings-box">
          <h3>Slot Configuration</h3>
          <div class="settings-row">
            <label>Total Slots:</label>
            <input type="number" id="total-slots-input" value="${MAX_SLOTS}" min="1" max="50">
          </div>
          <button class="btn-apply" onclick="applySettings()">Apply</button>
        </div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:15px">Camera Slots</h3>
        <table id="t"><tr><th>Slot</th><th>Status</th><th>Stream ID</th><th>Slot Link</th><th>Action</th></tr>${rowsHtml}</table>
      </div>
    </div>
    <script>
    let maxSlots=${MAX_SLOTS};

    // Initialize Socket.IO connection
    const socket=io();
    socket.on('connect',()=>console.log('Socket connected'));
    socket.on('disconnect',()=>console.log('Socket disconnected'));
    socket.on('connect_error',(err)=>console.error('Socket connection error:',err));

    async function loadSettings(){
      try{
        const j=await fetch('/api/state').then(r=>r.json());
        maxSlots=j.maxSlots||5;
        document.getElementById('total-slots-input').value=maxSlots;
        document.getElementById('total-slots').textContent=maxSlots;
      }catch(e){
        console.error('Failed to load settings:',e);
      }
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
      try{
        console.log('Refreshing slots...');
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
        console.log('Slots refreshed. Active:',activeCount);
      }catch(e){
        console.error('Failed to refresh slots:',e);
      }
    }

    async function updateSystemInfo(){
      try{
        console.log('Fetching system info...');
        const response=await fetch('/api/system');
        if(!response.ok){
          throw new Error('API responded with '+response.status);
        }
        const info=await response.json();
        console.log('System info received:',info);
        if(document.getElementById('cpu'))document.getElementById('cpu').textContent=info.cpuUsage||'N/A';
        if(document.getElementById('ram'))document.getElementById('ram').textContent=info.memPercent||'N/A';
        if(document.getElementById('temp'))document.getElementById('temp').textContent=info.temperature||'N/A';
        if(document.getElementById('disk'))document.getElementById('disk').textContent=info.diskPercent||'N/A';
        if(document.getElementById('disk-avail'))document.getElementById('disk-avail').textContent=info.diskAvailable||'N/A';
        if(document.getElementById('net-rx'))document.getElementById('net-rx').textContent=info.networkRx||'N/A';
        if(document.getElementById('net-tx'))document.getElementById('net-tx').textContent=info.networkTx||'N/A';
        if(document.getElementById('uptime'))document.getElementById('uptime').textContent=info.uptime||'N/A';
      }catch(e){
        console.error('Failed to fetch system info:',e);
        // Set error indicator
        if(document.getElementById('cpu'))document.getElementById('cpu').textContent='Error';
      }
    }

    loadSettings();
    socket.on('state',(data)=>{
      console.log('Received state update from server');
      refresh();
    });
    updateSystemInfo();
    setInterval(updateSystemInfo,5000);
    setInterval(refresh,2000);  // Also poll every 2 seconds as backup
    </script>
  `;
  res.send(dashboardLayout('Control',content));
});

// Network page
app.get("/network",async(req,res)=>{
  const content=`
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
        <h1>Network Devices</h1>
        <p class="subtitle">Devices on 192.168.8.x network</p>
      </div>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <h3>Discovered Devices</h3>
        <button class="btn-refresh" onclick="loadDevices()">Refresh</button>
      </div>
      <table id="device-table">
        <tr><th>IP Address</th><th>MAC Address</th><th>Hostname</th></tr>
        <tr><td colspan="3" style="text-align:center;padding:20px;color:#888">Loading devices...</td></tr>
      </table>
    </div>
    <script>
    async function loadDevices(){
      try{
        console.log('Loading network devices...');
        const data=await fetch('/api/network').then(r=>r.json());
        console.log('Network API response:',data);
        const devices=data.devices||[];
        let html='<tr><th>IP Address</th><th>MAC Address</th><th>Hostname</th></tr>';
        if(devices.length===0){
          let debugMsg='No devices found';
          if(data.debug){
            debugMsg+='<br><small style="color:#888">Scan method: '+(data.debug.scanMethod||'unknown')+'</small>';
            if(data.debug.arpTable){
              debugMsg+='<br><small style="color:#888">ARP entries: '+data.debug.arpTable.split('\\n').length+'</small>';
            }
          }
          html+=\`<tr><td colspan="3" style="text-align:center;padding:20px;color:#888">\${debugMsg}</td></tr>\`;
        }else{
          devices.forEach(d=>{
            html+=\`<tr>
              <td>\${d.ip}</td>
              <td style="font-family:monospace">\${d.mac}</td>
              <td>\${d.hostname}</td>
            </tr>\`;
          });
        }
        document.getElementById('device-table').innerHTML=html;
        console.log(\`Loaded \${devices.length} devices\`);
      }catch(e){
        console.error('Error loading devices:',e);
        document.getElementById('device-table').innerHTML='<tr><td colspan="3" style="text-align:center;padding:20px;color:#ef4444">Error loading devices: '+e.message+'</td></tr>';
      }
    }
    async function updateSystemInfo(){
      try{
        const response=await fetch('/api/system');
        if(!response.ok)throw new Error('API error');
        const info=await response.json();
        if(document.getElementById('cpu'))document.getElementById('cpu').textContent=info.cpuUsage||'N/A';
        if(document.getElementById('ram'))document.getElementById('ram').textContent=info.memPercent||'N/A';
        if(document.getElementById('temp'))document.getElementById('temp').textContent=info.temperature||'N/A';
        if(document.getElementById('disk'))document.getElementById('disk').textContent=info.diskPercent||'N/A';
        if(document.getElementById('disk-avail'))document.getElementById('disk-avail').textContent=info.diskAvailable||'N/A';
        if(document.getElementById('net-rx'))document.getElementById('net-rx').textContent=info.networkRx||'N/A';
        if(document.getElementById('net-tx'))document.getElementById('net-tx').textContent=info.networkTx||'N/A';
        if(document.getElementById('uptime'))document.getElementById('uptime').textContent=info.uptime||'N/A';
      }catch(e){console.error('System info error:',e);}
    }
    loadDevices();
    updateSystemInfo();
    setInterval(updateSystemInfo,5000);
    </script>
  `;
  res.send(dashboardLayout('Network',content));
});

// Debug page
app.get("/debug",async(req,res)=>{
  const content=`
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
        <h1>Debug & Logs</h1>
        <p class="subtitle">System diagnostics and logs</p>
      </div>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px">
        <h3>Service Logs (merimac-bridge)</h3>
        <button class="btn-refresh" onclick="loadLogs()">Refresh</button>
      </div>
      <div class="log-container" id="service-logs">Loading...</div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:15px">System Errors</h3>
      <div class="log-container" id="system-logs">Loading...</div>
    </div>
    <script>
    async function loadLogs(){
      try{
        const data=await fetch('/api/logs').then(r=>r.json());
        document.getElementById('service-logs').textContent=data.service||'No logs available';
        document.getElementById('system-logs').textContent=data.system||'No errors found';
      }catch(e){
        document.getElementById('service-logs').textContent='Error loading logs';
        document.getElementById('system-logs').textContent='Error loading logs';
      }
    }
    async function updateSystemInfo(){
      try{
        const response=await fetch('/api/system');
        if(!response.ok)throw new Error('API error');
        const info=await response.json();
        if(document.getElementById('cpu'))document.getElementById('cpu').textContent=info.cpuUsage||'N/A';
        if(document.getElementById('ram'))document.getElementById('ram').textContent=info.memPercent||'N/A';
        if(document.getElementById('temp'))document.getElementById('temp').textContent=info.temperature||'N/A';
        if(document.getElementById('disk'))document.getElementById('disk').textContent=info.diskPercent||'N/A';
        if(document.getElementById('disk-avail'))document.getElementById('disk-avail').textContent=info.diskAvailable||'N/A';
        if(document.getElementById('net-rx'))document.getElementById('net-rx').textContent=info.networkRx||'N/A';
        if(document.getElementById('net-tx'))document.getElementById('net-tx').textContent=info.networkTx||'N/A';
        if(document.getElementById('uptime'))document.getElementById('uptime').textContent=info.uptime||'N/A';
      }catch(e){console.error('System info error:',e);}
    }
    loadLogs();
    updateSystemInfo();
    setInterval(updateSystemInfo,5000);
    </script>
  `;
  res.send(dashboardLayout('Debug',content));
});

// Guide page
app.get("/guide",async(req,res)=>{
  const content=`
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
        <h1>User Guide</h1>
        <p class="subtitle">How to use the Merimac Video Ninja Bridge</p>
      </div>
    </div>
    <div class="card">
      <div class="guide-section">
        <h3>Getting Started</h3>
        <p>The Merimac Video Ninja Bridge allows you to easily connect multiple cameras to your live production using a single QR code.</p>
      </div>

      <div class="guide-section">
        <h3>How to Connect a Camera</h3>
        <ol>
          <li>Go to the <strong>Control</strong> page</li>
          <li>Show the QR code or share the join link: <code>${PUBLIC_HOST}/join</code></li>
          <li>On your phone/tablet, scan the QR code or open the link</li>
          <li>Click "Join Now" and allow camera/microphone permissions</li>
          <li>The camera will automatically be assigned to the next available slot</li>
          <li><strong>Keep the join page open</strong> during your show - closing it will disconnect</li>
        </ol>
      </div>

      <div class="guide-section">
        <h3>Adding Camera Feeds to OBS</h3>
        <ol>
          <li>In OBS, add a new <strong>Browser Source</strong></li>
          <li>Go to the Control page and find the slot you want to use</li>
          <li>Click the <strong>"Copy Link"</strong> button next to the slot</li>
          <li>Paste the URL into the OBS Browser Source settings</li>
          <li>Set width to <code>1920</code> and height to <code>1080</code> (or your desired resolution)</li>
          <li>Click OK - the camera feed will appear automatically when someone connects to that slot!</li>
        </ol>
        <p><strong>Pro tip:</strong> Set up all your slots in OBS once, and you never need to change the URLs again!</p>
      </div>

      <div class="guide-section">
        <h3>Managing Slots</h3>
        <p><strong>Configure Total Slots:</strong> You can set how many camera slots are available (1-50). Go to the Control page and adjust the "Total Slots" setting.</p>
        <p><strong>Clear a Slot:</strong> If a camera disconnects improperly, click the "Clear" button next to that slot.</p>
        <p><strong>View Slot Status:</strong> Active slots show a green "Active" badge. Empty slots show grey "Empty".</p>
      </div>

      <div class="guide-section">
        <h3>Troubleshooting</h3>
        <p><strong>Camera not showing up in OBS:</strong></p>
        <ul style="margin-left:20px;line-height:2">
          <li>Make sure the phone has an active internet connection</li>
          <li>Check that the join page is still open on the phone</li>
          <li>Try refreshing the OBS browser source</li>
          <li>Check the Debug page for errors</li>
        </ul>
        <p><strong>Slot doesn't clear automatically:</strong> Slots auto-clear after 8 seconds of inactivity. You can manually clear them using the "Clear" button.</p>
        <p><strong>Audio issues:</strong> Cameras join muted by default. Audio is transmitted to OBS but not back to the camera.</p>
      </div>

      <div class="guide-section">
        <h3>Network Page</h3>
        <p>View all devices connected to your network (192.168.8.x range). Useful for identifying which device is which.</p>
      </div>

      <div class="guide-section">
        <h3>Debug Page</h3>
        <p>View service logs and system errors. Check here if something isn't working correctly.</p>
      </div>
    </div>
    <script>
    async function updateSystemInfo(){
      try{
        const response=await fetch('/api/system');
        if(!response.ok)throw new Error('API error');
        const info=await response.json();
        if(document.getElementById('cpu'))document.getElementById('cpu').textContent=info.cpuUsage||'N/A';
        if(document.getElementById('ram'))document.getElementById('ram').textContent=info.memPercent||'N/A';
        if(document.getElementById('temp'))document.getElementById('temp').textContent=info.temperature||'N/A';
        if(document.getElementById('disk'))document.getElementById('disk').textContent=info.diskPercent||'N/A';
        if(document.getElementById('disk-avail'))document.getElementById('disk-avail').textContent=info.diskAvailable||'N/A';
        if(document.getElementById('net-rx'))document.getElementById('net-rx').textContent=info.networkRx||'N/A';
        if(document.getElementById('net-tx'))document.getElementById('net-tx').textContent=info.networkTx||'N/A';
        if(document.getElementById('uptime'))document.getElementById('uptime').textContent=info.uptime||'N/A';
      }catch(e){console.error('System info error:',e);}
    }
    updateSystemInfo();
    setInterval(updateSystemInfo,5000);
    </script>
  `;
  res.send(dashboardLayout('Guide',content));
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
