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

const INACTIVITY_MS = 12_000;
const GRACE_MS = 7_000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SLOTS = { 1:null,2:null,3:null,4:null,5:null };
const deviceIndex = new Map();

function now(){return Date.now();}
function firstFree(){for(let i=1;i<=5;i++) if(!SLOTS[i]) return i; return null;}
function claim(streamId,label){
  const id=String(streamId).replace(/[^a-zA-Z0-9]/g,"");
  if(deviceIndex.has(id)){const n=deviceIndex.get(id);SLOTS[n].last=now();return n;}
  const n=firstFree(); if(!n)return null;
  SLOTS[n]={streamId:id,label:label||"cam",since:now(),last:now(),grace:now()+GRACE_MS};
  deviceIndex.set(id,n); return n;
}
function clearSlot(n){if(SLOTS[n]){deviceIndex.delete(SLOTS[n].streamId);SLOTS[n]=null;}}
function clearById(id){const n=deviceIndex.get(id);if(!n)return;deviceIndex.delete(id);SLOTS[n]=null;return true;}

app.get("/api/state",(r,s)=>s.json({slots:SLOTS}));
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

app.get("/join",(req,res)=>{
  res.send(`<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Join Camera</title>
<style>body{background:#000;color:#fff;font-family:system-ui;text-align:center;padding:2em}</style>
</head><body>
<h2>Join the Show</h2><button id="go">Join Now</button>
<p id="msg">Keep this page open during the show.</p>
<script>
function id(){let i=localStorage.getItem("sid");if(!i){i=Math.random().toString(36).slice(2,12);localStorage.setItem("sid",i);}return i;}
const streamId=id();
async function post(u,b){return fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});}
setInterval(()=>post("/api/heartbeat",{streamId},true),7000);
window.addEventListener("pagehide",()=>post("/api/leave",{streamId},true));
document.getElementById("go").onclick=async()=>{
  const w=window.open("about:blank","_blank");
  const r=await post("/api/claim",{streamId});
  const j=await r.json(); if(!j.ok){w.close();return alert("All slots full");}
  const n=j.slot;
  w.location="${VDO}/?push="+encodeURIComponent(streamId)
             +"&label=cam"+n+"&bitrate=2500&codec=h264&autostart&webcam";
  document.getElementById("msg").innerText="Connected. Keep this tab open.";
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
setInterval(poll,5000);
</script></body></html>`);
});

app.get("/control",async(req,res)=>{
  const qr=await QRCode.toDataURL(`${PUBLIC_HOST}/join`);
  const rows=Object.entries(SLOTS).map(([n,s])=>`<tr>
  <td>${n}</td><td>${s?s.label:"-"}</td><td>${s?s.streamId:"-"}</td>
  <td><a href="/slot/${n}" target="_blank">Open</a></td>
  <td><button onclick="clearSlot(${n})">Clear</button></td></tr>`).join("");
  res.send(`<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Control</title>
<style>body{font-family:system-ui;margin:20px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px}</style>
</head><body>
<h2>Merimac Bridge Control</h2>
<img src="${qr}" width="180"><p><a href="${PUBLIC_HOST}/join" target="_blank">${PUBLIC_HOST}/join</a></p>
<table id="t"><tr><th>Slot</th><th>Label</th><th>ID</th><th>Open</th><th></th></tr>${rows}</table>
<script src="/socket.io/socket.io.js"></script>
<script>
async function clearSlot(n){await fetch('/api/clear/'+n,{method:'POST'});refresh();}
async function refresh(){const j=await fetch('/api/state').then(r=>r.json());
let h='<tr><th>Slot</th><th>Label</th><th>ID</th><th>Open</th><th></th></tr>';
for(let i=1;i<=5;i++){const s=j.slots[i];h+=\`<tr><td>\${i}</td><td>\${s?s.label:'-'}</td><td>\${s?s.streamId:'-'}</td>
<td><a href="/slot/\${i}" target="_blank">Open</a></td><td><button onclick="clearSlot(\${i})">Clear</button></td></tr>\`;}
document.getElementById('t').innerHTML=h;}
io().on('state',refresh);
</script></body></html>`);
});

setInterval(()=>{
  const t=now();let ch=false;
  for(let i=1;i<=5;i++){
    const s=SLOTS[i];if(!s)continue;
    if(t-s.last>INACTIVITY_MS && t>s.grace){deviceIndex.delete(s.streamId);SLOTS[i]=null;ch=true;}
  }
  if(ch)io.emit("state",{slots:SLOTS});
},3000);

server.listen(PORT,()=>console.log("Bridge listening :"+PORT));
