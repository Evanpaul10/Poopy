/****************************************************************
 * Merimac VDO.Ninja Bridge — Fixed Browser Autoplay (Nov 2025)
 ****************************************************************/
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = 8080;
const PUBLIC_HOST = "https://bridge.merimac.ca";
const VDO = "https://vdo.ninja";
const ROOM = "MERIMAC";

const INACTIVITY_MS = 8_000;  // Clear inactive slots after 8 seconds
const GRACE_MS = 5_000;        // 5 second grace period on initial connection

// Settings file path
const SETTINGS_FILE = path.join(__dirname, 'bridge-settings.json');
const ACTIVITY_LOG_FILE = path.join(__dirname, 'activity-log.json');
const CAMERAS_FILE = path.join(__dirname, 'camera-control.json');

// Default settings
let SETTINGS = {
  username: "admin",
  password: "Cameldog99#",
  resetPin: "898989",
  maxSlots: 5,
  bitrate: 2500,
  networkRefreshInterval: 5 // minutes
};

// Activity log (in-memory with file backup)
let ACTIVITY_LOG = [];

// Camera control storage
let CAMERAS = []; // Array of {id, name, ip, connected, lastSeen, settings}
const cameraConnections = new Map(); // ip -> WebSocket connection

// Login attempt tracking for rate limiting
const loginAttempts = new Map(); // IP -> {count, lastAttempt, lockedUntil}

// Load settings from file
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const loaded = JSON.parse(data);
      SETTINGS = { ...SETTINGS, ...loaded };
      console.log('Settings loaded from file');
    }
  } catch (e) {
    console.error('Error loading settings:', e.message);
  }
}

// Save settings to file
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(SETTINGS, null, 2));
    console.log('Settings saved to file');
  } catch (e) {
    console.error('Error saving settings:', e.message);
  }
}

// Load activity log
function loadActivityLog() {
  try {
    if (fs.existsSync(ACTIVITY_LOG_FILE)) {
      const data = fs.readFileSync(ACTIVITY_LOG_FILE, 'utf8');
      ACTIVITY_LOG = JSON.parse(data);
      // Keep only last 500 entries
      if (ACTIVITY_LOG.length > 500) {
        ACTIVITY_LOG = ACTIVITY_LOG.slice(-500);
      }
      console.log(`Activity log loaded: ${ACTIVITY_LOG.length} entries`);
    }
  } catch (e) {
    console.error('Error loading activity log:', e.message);
  }
}

// Save activity log
function saveActivityLog() {
  try {
    fs.writeFileSync(ACTIVITY_LOG_FILE, JSON.stringify(ACTIVITY_LOG, null, 2));
  } catch (e) {
    console.error('Error saving activity log:', e.message);
  }
}

// Add activity log entry
function logActivity(type, message, slotNumber = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    type, // 'join', 'leave', 'clear', 'system'
    message,
    slot: slotNumber
  };
  ACTIVITY_LOG.push(entry);
  // Keep only last 500 entries in memory
  if (ACTIVITY_LOG.length > 500) {
    ACTIVITY_LOG.shift();
  }
  // Save periodically (every 10 entries)
  if (ACTIVITY_LOG.length % 10 === 0) {
    saveActivityLog();
  }
  // Emit to connected clients
  io.emit('activity', entry);
}

// Load cameras from file
function loadCameras() {
  try {
    if (fs.existsSync(CAMERAS_FILE)) {
      const data = fs.readFileSync(CAMERAS_FILE, 'utf8');
      CAMERAS = JSON.parse(data);
      console.log(`Cameras loaded: ${CAMERAS.length} cameras`);
    }
  } catch (e) {
    console.error('Error loading cameras:', e.message);
  }
}

// Save cameras to file
function saveCameras() {
  try {
    fs.writeFileSync(CAMERAS_FILE, JSON.stringify(CAMERAS, null, 2));
    console.log('Cameras saved to file');
  } catch (e) {
    console.error('Error saving cameras:', e.message);
  }
}

// Load settings on startup
loadSettings();
loadActivityLog();
loadCameras();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session middleware
app.use(session({
  secret: 'merimac-bridge-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to true if using HTTPS directly (Cloudflare tunnel handles this)
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

const SLOTS = {};
for(let i=1;i<=50;i++)SLOTS[i]=null;
const deviceIndex = new Map();

let MAX_SLOTS = SETTINGS.maxSlots; // Load from settings

// Authentication middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  res.redirect('/login');
}

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

// Root route - redirect to control page
app.get("/", (req, res) => {
  res.redirect('/control');
});

// Login page
app.get("/login", (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/control');
  }
  const error = req.query.error;
  const minutes = req.query.minutes || 15;
  let errorMsg = '';
  if (error === 'locked') {
    errorMsg = `Too many failed attempts. Account locked for ${minutes} minutes. Use Forgot Password to recover.`;
  } else if (error === '1') {
    errorMsg = 'Invalid username or password';
  }

  res.send(`<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Login - Merimac Bridge</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
    color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .login-container{background:#1a1a2e;border-radius:16px;padding:40px;max-width:400px;width:100%;
    box-shadow:0 20px 60px rgba(0,0,0,0.4)}
  h1{text-align:center;margin-bottom:10px;font-size:2em;color:#fff}
  .subtitle{text-align:center;color:#888;margin-bottom:30px}
  .form-group{margin-bottom:20px}
  label{display:block;margin-bottom:8px;color:#e0e0e0;font-weight:500}
  input{width:100%;padding:12px 16px;background:#252540;border:2px solid #667eea;
    color:#fff;border-radius:8px;font-size:1em;transition:all 0.2s}
  input:focus{outline:none;border-color:#764ba2}
  .btn-login{width:100%;background:#667eea;color:#fff;border:none;padding:14px;
    border-radius:8px;font-size:1.1em;font-weight:600;cursor:pointer;transition:all 0.3s;
    margin-top:10px}
  .btn-login:hover{background:#764ba2;transform:translateY(-2px);box-shadow:0 10px 30px rgba(102,126,234,0.4)}
  .btn-login:active{transform:translateY(0)}
  .error{background:#ef4444;color:#fff;padding:12px;border-radius:8px;margin-bottom:20px;text-align:center}
  .forgot-link{text-align:center;margin-top:20px}
  .forgot-link a{color:#667eea;text-decoration:none;font-weight:500}
  .forgot-link a:hover{text-decoration:underline}
</style>
</head><body>
<div class="login-container">
  <h1>🔒 Merimac Bridge</h1>
  <p class="subtitle">Admin Login</p>
  ${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}
  <form method="POST" action="/login">
    <div class="form-group">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" required autofocus>
    </div>
    <div class="form-group">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required>
    </div>
    <button type="submit" class="btn-login">Login</button>
  </form>
  <div class="forgot-link">
    <a href="/forgot-password">Forgot Password?</a>
  </div>
</div>
</body></html>`);
});

// Login POST with rate limiting
app.post("/login", (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();

  // Check if IP is locked out
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.lockedUntil && now < attempt.lockedUntil) {
    const remainingMin = Math.ceil((attempt.lockedUntil - now) / 60000);
    return res.redirect(`/login?error=locked&minutes=${remainingMin}`);
  }

  const { username, password } = req.body;
  if (username === SETTINGS.username && password === SETTINGS.password) {
    // Successful login - clear attempts
    loginAttempts.delete(ip);
    req.session.authenticated = true;
    req.session.username = username;
    logActivity('system', `User ${username} logged in from ${ip}`);
    res.redirect('/control');
  } else {
    // Failed login - track attempt
    if (!attempt) {
      loginAttempts.set(ip, { count: 1, lastAttempt: now });
    } else {
      attempt.count++;
      attempt.lastAttempt = now;

      // Lock after 5 failed attempts for 15 minutes
      if (attempt.count >= 5) {
        attempt.lockedUntil = now + (15 * 60 * 1000);
        logActivity('system', `Login locked for IP ${ip} after 5 failed attempts`);
        return res.redirect('/login?error=locked&minutes=15');
      }
    }
    res.redirect('/login?error=1');
  }
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Forgot password page
app.get("/forgot-password", (req, res) => {
  const error = req.query.error;
  const success = req.query.success;
  const username = req.query.u || '';
  const password = req.query.p || '';
  res.send(`<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Reset Password - Merimac Bridge</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
    color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .login-container{background:#1a1a2e;border-radius:16px;padding:40px;max-width:400px;width:100%;
    box-shadow:0 20px 60px rgba(0,0,0,0.4)}
  h1{text-align:center;margin-bottom:10px;font-size:2em;color:#fff}
  .subtitle{text-align:center;color:#888;margin-bottom:30px}
  .form-group{margin-bottom:20px}
  label{display:block;margin-bottom:8px;color:#e0e0e0;font-weight:500}
  input{width:100%;padding:12px 16px;background:#252540;border:2px solid #667eea;
    color:#fff;border-radius:8px;font-size:1em;transition:all 0.2s}
  input:focus{outline:none;border-color:#764ba2}
  .btn-reset{width:100%;background:#667eea;color:#fff;border:none;padding:14px;
    border-radius:8px;font-size:1.1em;font-weight:600;cursor:pointer;transition:all 0.3s;
    margin-top:10px}
  .btn-reset:hover{background:#764ba2;transform:translateY(-2px);box-shadow:0 10px 30px rgba(102,126,234,0.4)}
  .btn-reset:active{transform:translateY(0)}
  .error{background:#ef4444;color:#fff;padding:12px;border-radius:8px;margin-bottom:20px;text-align:center}
  .success{background:#10b981;color:#fff;padding:12px;border-radius:8px;margin-bottom:20px;text-align:center}
  .back-link{text-align:center;margin-top:20px}
  .back-link a{color:#667eea;text-decoration:none;font-weight:500}
  .back-link a:hover{text-decoration:underline}
  .info{background:rgba(102,126,234,0.2);color:#e0e0e0;padding:12px;border-radius:8px;
    margin-bottom:20px;text-align:center;font-size:0.9em}
</style>
</head><body>
<div class="login-container">
  <h1>🔑 Reset Password</h1>
  <p class="subtitle">Enter PIN to view credentials</p>
  ${error ? '<div class="error">Invalid PIN</div>' : ''}
  ${success ? `<div class="success">Username: <strong>${username}</strong><br>Password: <strong>${password}</strong></div>` : ''}
  ${!success ? `<form method="POST" action="/forgot-password">
    <div class="info">Enter the 6-digit PIN to retrieve your login credentials</div>
    <div class="form-group">
      <label for="pin">Security PIN</label>
      <input type="text" id="pin" name="pin" pattern="[0-9]{6}" maxlength="6" required autofocus placeholder="000000">
    </div>
    <button type="submit" class="btn-reset">Retrieve Credentials</button>
  </form>` : ''}
  <div class="back-link">
    <a href="/login">← Back to Login</a>
  </div>
</div>
</body></html>`);
});

// Forgot password POST
app.post("/forgot-password", (req, res) => {
  const { pin } = req.body;
  if (pin === SETTINGS.resetPin) {
    res.redirect('/forgot-password?success=1&u=' + encodeURIComponent(SETTINGS.username) + '&p=' + encodeURIComponent(SETTINGS.password));
  } else {
    res.redirect('/forgot-password?error=1');
  }
});

app.get("/api/state",(r,s)=>s.json({slots:SLOTS,maxSlots:MAX_SLOTS}));
app.post("/api/config",requireAuth,(r,s)=>{
  const {maxSlots}=r.body||{};
  if(maxSlots&&maxSlots>=1&&maxSlots<=50){
    MAX_SLOTS=maxSlots;
    SETTINGS.maxSlots=maxSlots;
    saveSettings();
    logActivity('system', `Max slots changed to ${maxSlots}`);
    s.json({ok:true,maxSlots:MAX_SLOTS});
  }else{
    s.json({ok:false,error:"maxSlots must be between 1 and 50"});
  }
});
app.post("/api/claim",(r,s)=>{
  const {streamId,label}=r.body||{};
  if(!streamId)return s.json({ok:false});
  const n=claim(streamId,label);
  if(!n)return s.json({ok:false,error:"full"});
  logActivity('join', `Camera joined slot ${n}`, n);
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
  const n=deviceIndex.get(id);
  const c=clearById(id);
  if(c){
    logActivity('leave', `Camera left slot ${n}`, n);
    io.emit("state",{slots:SLOTS});
  }
  s.json({ok:!!c});
});
app.post("/api/clear/:n",requireAuth,(r,s)=>{
  const n=+r.params.n;
  if(SLOTS[n]){
    clearSlot(n);
    logActivity('clear', `Slot ${n} cleared manually`, n);
    io.emit("state",{slots:SLOTS});
  }
  s.json({ok:true});
});
app.get("/health",(r,s)=>s.json({ok:true,active:Object.values(SLOTS).filter(Boolean).length}));

// Settings API
app.get("/api/settings",requireAuth,(r,s)=>{
  s.json({
    bitrate: SETTINGS.bitrate,
    networkRefreshInterval: SETTINGS.networkRefreshInterval
  });
});

app.post("/api/settings",requireAuth,(r,s)=>{
  const {bitrate, networkRefreshInterval, username, password, resetPin}=r.body||{};

  // Update bitrate
  if(bitrate && bitrate >= 500 && bitrate <= 10000){
    SETTINGS.bitrate = bitrate;
  }

  // Update network refresh interval
  if(networkRefreshInterval && networkRefreshInterval >= 1 && networkRefreshInterval <= 60){
    SETTINGS.networkRefreshInterval = networkRefreshInterval;
  }

  // Update credentials
  if(username && username.length >= 3){
    SETTINGS.username = username;
    logActivity('system', `Username changed to ${username}`);
  }

  if(password && password.length >= 6){
    SETTINGS.password = password;
    logActivity('system', 'Password changed');
  }

  if(resetPin && /^\d{6}$/.test(resetPin)){
    SETTINGS.resetPin = resetPin;
    logActivity('system', 'Reset PIN changed');
  }

  saveSettings();
  s.json({ok:true, settings: {bitrate: SETTINGS.bitrate, networkRefreshInterval: SETTINGS.networkRefreshInterval}});
});

// Clear all slots API
app.post("/api/clear-all",requireAuth,(r,s)=>{
  let clearedCount = 0;
  for(let i=1; i<=MAX_SLOTS; i++){
    if(SLOTS[i]){
      clearSlot(i);
      clearedCount++;
    }
  }
  logActivity('clear', `All slots cleared (${clearedCount} cameras disconnected)`);
  io.emit("state",{slots:SLOTS});
  s.json({ok:true, cleared: clearedCount});
});

// Activity log API
app.get("/api/activity",requireAuth,(r,s)=>{
  const limit = parseInt(r.query.limit) || 100;
  const logs = ACTIVITY_LOG.slice(-limit).reverse();
  s.json({logs});
});

// Camera Control API
app.get("/api/cameras",requireAuth,(r,s)=>{
  s.json({cameras: CAMERAS});
});

app.post("/api/cameras/scan",requireAuth,async(r,s)=>{
  const {exec}=require("child_process");
  const util=require("util");
  const execAsync=util.promisify(exec);
  const net=require("net");

  try{
    const foundCameras=[];
    const {customSubnet}=r.body||{};

    // Get all network interfaces
    const os=require("os");
    const interfaces=os.networkInterfaces();
    const subnets=new Set();
    const localIPs=new Set();

    // Extract all local network subnets and local IPs
    for(const ifname in interfaces){
      for(const iface of interfaces[ifname]){
        if(iface.family==='IPv4' && !iface.internal){
          localIPs.add(iface.address);
          const parts=iface.address.split('.');
          const subnet=parts[0]+'.'+parts[1]+'.'+parts[2];
          subnets.add(subnet);
        }
      }
    }

    // If custom subnet provided, use only that
    if(customSubnet){
      subnets.clear();
      subnets.add(customSubnet);
      console.log('Scanning custom subnet:',customSubnet);
    }else{
      // Only scan Pi's local networks by default (not all common ranges)
      console.log('Scanning local subnets only:',Array.from(subnets));
    }

    console.log('Local IPs to exclude:',Array.from(localIPs));

    // Helper function to check a single IP
    function checkPort(ip, port, timeout){
      return new Promise((resolve)=>{
        const socket=new net.Socket();
        socket.setTimeout(timeout);
        socket.on('connect',()=>{
          socket.destroy();
          resolve({ip,open:true});
        });
        socket.on('timeout',()=>{
          socket.destroy();
          resolve({ip,open:false});
        });
        socket.on('error',()=>{
          socket.destroy();
          resolve({ip,open:false});
        });
        socket.connect(port,ip);
      });
    }

    // Scan each subnet in batches for better performance
    for(const subnet of subnets){
      const batchSize=100; // Scan 100 IPs at a time for speed
      for(let start=1;start<255;start+=batchSize){
        const batch=[];
        for(let i=start;i<Math.min(start+batchSize,255);i++){
          const ip=subnet+'.'+i;
          // Skip local IPs
          if(!localIPs.has(ip)){
            batch.push(checkPort(ip,8888,1000)); // 1 second timeout for speed
          }
        }

        const results=await Promise.all(batch);
        for(const result of results){
          if(result.open){
            // Check if already in CAMERAS
            const existing=CAMERAS.find(c=>c.ip===result.ip);
            if(!existing){
              console.log('Found camera at:',result.ip);
              foundCameras.push({
                ip:result.ip,
                name:'Camera '+result.ip,
                autoDetected:true
              });
            }
          }
        }
      }
    }

    console.log('Scan complete. Found cameras:',foundCameras);
    s.json({cameras:foundCameras,scannedSubnets:Array.from(subnets)});
  }catch(e){
    console.error('Camera scan error:',e);
    s.json({error:e.message,cameras:[]});
  }
});

app.post("/api/cameras/add",requireAuth,(r,s)=>{
  const {ip,name}=r.body;
  if(!ip){
    return s.json({ok:false,error:'IP address required'});
  }

  // Check if camera already exists
  const existing=CAMERAS.find(c=>c.ip===ip);
  if(existing){
    return s.json({ok:false,error:'Camera already exists'});
  }

  const camera={
    id:Date.now().toString(),
    name:name||'Camera '+ip,
    ip:ip,
    connected:false,
    lastSeen:null,
    settings:{}
  };

  CAMERAS.push(camera);
  saveCameras();
  logActivity('system',`Camera added: ${camera.name} (${camera.ip})`);
  io.emit('cameras',{cameras:CAMERAS});
  s.json({ok:true,camera});
});

app.delete("/api/cameras/:id",requireAuth,(r,s)=>{
  const id=r.params.id;
  const index=CAMERAS.findIndex(c=>c.id===id);
  if(index===-1){
    return s.json({ok:false,error:'Camera not found'});
  }

  const camera=CAMERAS[index];

  // Close WebSocket connection if exists
  if(cameraConnections.has(camera.ip)){
    const ws=cameraConnections.get(camera.ip);
    ws.close();
    cameraConnections.delete(camera.ip);
  }

  CAMERAS.splice(index,1);
  saveCameras();
  logActivity('system',`Camera removed: ${camera.name} (${camera.ip})`);
  io.emit('cameras',{cameras:CAMERAS});
  s.json({ok:true});
});

app.post("/api/cameras/:id/connect",requireAuth,(r,s)=>{
  const id=r.params.id;
  const camera=CAMERAS.find(c=>c.id===id);
  if(!camera){
    return s.json({ok:false,error:'Camera not found'});
  }

  // Check if already connected
  if(cameraConnections.has(camera.ip)){
    return s.json({ok:true,alreadyConnected:true});
  }

  try{
    const ws=new WebSocket(`ws://${camera.ip}:8888`);

    ws.on('open',()=>{
      console.log(`Connected to camera ${camera.name} (${camera.ip})`);
      camera.connected=true;
      camera.lastSeen=new Date().toISOString();
      cameraConnections.set(camera.ip,ws);
      io.emit('cameras',{cameras:CAMERAS});
      logActivity('system',`Connected to camera: ${camera.name} (${camera.ip})`);
    });

    ws.on('message',(data)=>{
      try{
        const msg=JSON.parse(data);
        // Store camera settings when received
        if(msg.messageType==='deviceConfiguration' || msg.content){
          try{
            const content=typeof msg.content==='string'?JSON.parse(msg.content):msg.content;
            camera.settings=content;
            io.emit('camera-update',{cameraId:camera.id,settings:content});
          }catch(e){
            console.error('Error parsing camera settings:',e);
          }
        }
      }catch(e){
        console.error('Error parsing WebSocket message:',e);
      }
    });

    ws.on('close',()=>{
      console.log(`Disconnected from camera ${camera.name} (${camera.ip})`);
      camera.connected=false;
      cameraConnections.delete(camera.ip);
      io.emit('cameras',{cameras:CAMERAS});
      logActivity('system',`Disconnected from camera: ${camera.name} (${camera.ip})`);
    });

    ws.on('error',(err)=>{
      console.error(`Camera ${camera.name} WebSocket error:`,err.message);
      camera.connected=false;
      cameraConnections.delete(camera.ip);
      io.emit('cameras',{cameras:CAMERAS});
    });

    s.json({ok:true});
  }catch(e){
    console.error('Error connecting to camera:',e);
    s.json({ok:false,error:e.message});
  }
});

app.post("/api/cameras/:id/command",requireAuth,(r,s)=>{
  const id=r.params.id;
  const camera=CAMERAS.find(c=>c.id===id);
  if(!camera){
    return s.json({ok:false,error:'Camera not found'});
  }

  const ws=cameraConnections.get(camera.ip);
  if(!ws || ws.readyState!==WebSocket.OPEN){
    return s.json({ok:false,error:'Camera not connected'});
  }

  try{
    const command=r.body;
    const message={
      messageType:"setDeviceConfiguration",
      content:JSON.stringify(command)
    };
    ws.send(JSON.stringify(message));
    s.json({ok:true});
  }catch(e){
    console.error('Error sending command:',e);
    s.json({ok:false,error:e.message});
  }
});

app.get("/api/system",requireAuth,async(r,s)=>{
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

app.get("/api/network",requireAuth,async(r,s)=>{
  const {exec}=require("child_process");
  const util=require("util");
  const execAsync=util.promisify(exec);

  try{
    const devices=[];
    let debugInfo={};

    // First, ping the network to populate ARP cache
    console.log('Starting network scan for all devices...');
    try{
      // Get current network interface and subnet
      const {stdout:ipInfo}=await execAsync("ip route | grep default | head -1").catch(()=>({stdout:''}));
      console.log('IP route info:',ipInfo);

      // Try fping first (fastest)
      const fpingResult=await execAsync("fping -a -g 192.168.8.0/24",{timeout:8000}).catch(e=>{
        console.log('fping error:',e.message);
        return null;
      });
      if(fpingResult && fpingResult.stdout){
        console.log('fping completed successfully');
        debugInfo.scanMethod='fping';
      }else{
        console.log('fping did not complete, trying arp-scan...');
        // Try arp-scan (requires root, but very reliable)
        const arpscanResult=await execAsync("sudo arp-scan -l",{timeout:8000}).catch(e=>{
          console.log('arp-scan error:',e.message);
          return null;
        });
        if(arpscanResult && arpscanResult.stdout){
          console.log('arp-scan completed successfully');
          debugInfo.scanMethod='arp-scan';
          debugInfo.arpscanOutput=arpscanResult.stdout;
        }else{
          console.log('Using existing ARP table only');
          debugInfo.scanMethod='arp-table-only';
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
      const unmatchedLines=[];
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
            }else{
              // Try even simpler format: just IP and MAC anywhere in line
              match=line.match(/(\d+\.\d+\.\d+\.\d+).*?([0-9a-f]{1,2}:[0-9a-f]{1,2}:[0-9a-f]{1,2}:[0-9a-f]{1,2}:[0-9a-f]{1,2}:[0-9a-f]{1,2})/i);
              if(match){
                ip=match[1];
                mac=match[2].toUpperCase();
              }else{
                // Couldn't parse this line
                unmatchedLines.push(line);
              }
            }
          }
        }

        // Show ALL devices, not just 192.168.8.x
        if(ip && mac && mac!=='00:00:00:00:00:00' && !mac.includes('INCOMPLETE')){
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

      if(unmatchedLines.length>0){
        console.log('Unmatched ARP lines:',unmatchedLines);
        debugInfo.unmatchedLines=unmatchedLines;
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

app.get("/api/logs",requireAuth,async(r,s)=>{
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
  .toast{position:fixed;top:20px;right:20px;background:#1a1a2e;color:#fff;padding:15px 25px;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.5);z-index:9999;min-width:250px;animation:slideIn 0.3s ease}
  .toast.success{border-left:4px solid #10b981}
  .toast.error{border-left:4px solid #ef4444}
  .toast.info{border-left:4px solid #667eea}
  @keyframes slideIn{from{transform:translateX(400px);opacity:0}to{transform:translateX(0);opacity:1}}
  @keyframes slideOut{from{transform:translateX(0);opacity:1}to{transform:translateX(400px);opacity:0}}
  .toast.hiding{animation:slideOut 0.3s ease}
  .form-group{margin-bottom:20px}
  .form-group label{display:block;margin-bottom:8px;color:#e0e0e0;font-weight:500}
  .form-group input,.form-group select{width:100%;padding:12px 16px;background:#252540;border:2px solid #667eea;color:#fff;border-radius:8px;font-size:1em;transition:all 0.2s}
  .form-group input:focus,.form-group select:focus{outline:none;border-color:#764ba2}
  .form-group small{display:block;margin-top:5px;color:#888;font-size:0.9em}
  .btn-save{background:#10b981;color:#fff;border:none;padding:12px 30px;border-radius:8px;cursor:pointer;font-weight:600;transition:all 0.2s;font-size:1em}
  .btn-save:hover{background:#059669;transform:translateY(-1px)}
  .btn-clear-all{background:#ef4444;color:#fff;border:none;padding:10px 24px;border-radius:8px;cursor:pointer;font-weight:600;transition:all 0.2s}
  .btn-clear-all:hover{background:#dc2626;transform:translateY(-1px)}
  .activity-entry{padding:12px;border-left:3px solid #667eea;background:#1e1e35;margin-bottom:10px;border-radius:4px}
  .activity-entry.join{border-left-color:#10b981}
  .activity-entry.leave{border-left-color:#f59e0b}
  .activity-entry.clear{border-left-color:#ef4444}
  .activity-entry.system{border-left-color:#667eea}
  .activity-time{font-size:0.85em;color:#888;margin-bottom:5px}
  .activity-message{color:#e0e0e0}
  .duration{font-size:0.85em;color:#888;margin-left:10px}
</style>
</head><body>
<div class="sidebar">
  <div class="sidebar-title">Merimac Bridge</div>
  <a href="/control" class="nav-item ${pageName==='Control'?'active':''}">Control</a>
  <a href="/group" class="nav-item ${pageName==='Group Feed'?'active':''}" target="_blank">Group Feed</a>
  <a href="/camera-control" class="nav-item ${pageName==='Camera Control'?'active':''}">Camera Control</a>
  <a href="/network" class="nav-item ${pageName==='Network'?'active':''}">Network</a>
  <a href="/activity" class="nav-item ${pageName==='Activity'?'active':''}">Activity Log</a>
  <a href="/debug" class="nav-item ${pageName==='Debug'?'active':''}">Debug</a>
  <a href="/guide" class="nav-item ${pageName==='Guide'?'active':''}">Guide</a>
  <a href="/settings" class="nav-item ${pageName==='Settings'?'active':''}">Settings</a>
  <div style="margin-top:auto;padding-top:20px;border-top:1px solid #2a2a3e">
    <a href="/logout" class="nav-item" style="color:#ef4444">Logout</a>
  </div>
</div>
<div class="main-content">
  <div class="container">
    ${content}
  </div>
</div>
<script>
// Toast notification system
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = \`toast \${type}\`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
</script>
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
  console.log("Join button clicked, stream ID:",streamId);
  const w=window.open("about:blank","_blank");
  const r=await post("/api/claim",{streamId});
  const j=await r.json();
  console.log("Claim response:",j);
  if(!j.ok){w.close();return alert("All slots full");}
  const n=j.slot;
  const vdoUrl="${VDO}/?push="+encodeURIComponent(streamId)
             +"&label=cam"+n+"&bitrate=${SETTINGS.bitrate}&codec=h264&autostart&webcam&muted&relay";
  console.log("Opening VDO.Ninja pusher:",vdoUrl);
  w.location=vdoUrl;
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
          +"&cleanoutput=1&stats=0&scene&autostart=1&coverview&relay";
  if(!isOBS())url+="&muted=1";

  console.log("Loading VDO.Ninja viewer for stream:",id);
  console.log("URL:",url);

  // Add debug overlay at top
  const debugDiv=document.createElement("div");
  debugDiv.style.cssText="position:fixed;top:0;left:0;right:0;background:rgba(0,0,0,0.8);color:#0f0;padding:10px;font-family:monospace;font-size:12px;z-index:10000;max-width:100%;overflow:hidden;";
  debugDiv.innerHTML=\`Stream: \${id.substring(0,20)}...<br>Network: \${window.location.hostname}\`;
  wrap.appendChild(debugDiv);
  setTimeout(()=>debugDiv.remove(),8000); // Remove after 8 sec

  const f=document.createElement("iframe");
  f.allow="autoplay; camera; microphone; fullscreen; display-capture; encrypted-media; picture-in-picture";
  f.setAttribute("allowfullscreen","");
  f.style.width="100%";
  f.style.height="100%";
  f.style.border="0";
  f.style.display="block";
  f.src=url;

  // Debug iframe load
  f.onload=()=>{
    console.log("VDO.Ninja iframe loaded");
    const loadMsg=document.createElement("div");
    loadMsg.style.cssText="position:fixed;bottom:10px;right:10px;background:rgba(0,255,0,0.8);color:#fff;padding:8px 15px;border-radius:5px;z-index:10001;font-size:14px;";
    loadMsg.textContent="✅ Iframe loaded";
    wrap.appendChild(loadMsg);
    setTimeout(()=>loadMsg.remove(),3000);
  };
  f.onerror=(e)=>{
    console.error("VDO.Ninja iframe error:",e);
    const errMsg=document.createElement("div");
    errMsg.style.cssText="position:fixed;bottom:10px;right:10px;background:rgba(255,0,0,0.9);color:#fff;padding:8px 15px;border-radius:5px;z-index:10001;font-size:14px;";
    errMsg.textContent="❌ Iframe failed";
    wrap.appendChild(errMsg);
  };

  wrap.appendChild(f);

  // Add click-to-play overlay for browsers (not OBS)
  if(!isOBS()){
    needsClick=true;
    const ov=document.createElement("div");
    ov.id="overlay";
    ov.innerHTML='<div>▶ Click to Play Video<br><small style="font-size:14px;opacity:0.7;margin-top:10px;display:block">Camera slot ${n} is active</small></div>';
    ov.onclick=()=>{
      console.log("User clicked to start video");
      ov.innerHTML='<div>Loading video stream...</div>';
      setTimeout(()=>{
        ov.remove();
        needsClick=false;
        // Completely recreate the iframe with autoplay after user interaction
        f.remove();
        const newFrame=document.createElement("iframe");
        newFrame.allow="autoplay; camera; microphone; fullscreen; display-capture; encrypted-media; picture-in-picture";
        newFrame.setAttribute("allowfullscreen","");
        newFrame.style.width="100%";
        newFrame.style.height="100%";
        newFrame.style.border="0";
        newFrame.style.display="block";
        newFrame.src=url;
        newFrame.onload=()=>{
          console.log("VDO.Ninja iframe reloaded after click");
          const reloadMsg=document.createElement("div");
          reloadMsg.style.cssText="position:fixed;bottom:10px;right:10px;background:rgba(0,255,0,0.8);color:#fff;padding:8px 15px;border-radius:5px;z-index:10001;font-size:14px;";
          reloadMsg.textContent="✅ Iframe reloaded";
          wrap.appendChild(reloadMsg);
          setTimeout(()=>reloadMsg.remove(),3000);
        };
        newFrame.onerror=(e)=>{
          console.error("Reload error:",e);
          const errMsg=document.createElement("div");
          errMsg.style.cssText="position:fixed;bottom:10px;right:10px;background:rgba(255,0,0,0.9);color:#fff;padding:8px 15px;border-radius:5px;z-index:10001;font-size:14px;";
          errMsg.textContent="❌ Reload failed";
          wrap.appendChild(errMsg);
        };
        wrap.appendChild(newFrame);
        console.log("Recreated iframe with autoplay");
      },300);
    };
    wrap.appendChild(ov);
  }else{
    console.log("OBS detected, skipping click-to-play overlay");
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

// Group feed - show all active cameras in auto-scaling grid
app.get("/group",(req,res)=>{
  res.send(`<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Group Feed - All Cameras</title>
<style>
html,body{margin:0;height:100%;background:#000;overflow:hidden;font-family:system-ui}
#grid{display:grid;gap:2px;width:100%;height:100%;padding:2px;box-sizing:border-box}
#grid.count-1{grid-template-columns:1fr;grid-template-rows:1fr}
#grid.count-2,#grid.count-3,#grid.count-4{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
#grid.count-5,#grid.count-6,#grid.count-7,#grid.count-8,#grid.count-9{grid-template-columns:1fr 1fr 1fr;grid-template-rows:1fr 1fr 1fr}
#grid.count-10,#grid.count-11,#grid.count-12,#grid.count-13,#grid.count-14,#grid.count-15,#grid.count-16{grid-template-columns:1fr 1fr 1fr 1fr;grid-template-rows:1fr 1fr 1fr 1fr}
.slot-container{position:relative;background:#111;overflow:hidden;min-height:150px}
.slot-container iframe{width:100%;height:100%;border:0;display:block}
.slot-label{position:absolute;top:5px;left:5px;background:rgba(0,0,0,0.7);color:#fff;padding:4px 10px;border-radius:4px;font-size:12px;z-index:100;font-weight:500}
.waiting{color:#666;display:flex;align-items:center;justify-content:center;height:100%;font-size:14px}
#overlay{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);
  display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:999;flex-direction:column;gap:15px}
#overlay .play-btn{background:#10b981;color:#fff;padding:20px 50px;border-radius:12px;font-size:20px;font-weight:600;box-shadow:0 4px 12px rgba(16,185,129,0.4)}
#overlay .play-btn:hover{background:#059669;transform:scale(1.05);transition:all 0.2s}
#overlay .count{color:#999;font-size:14px}
#no-cameras{display:flex;align-items:center;justify-content:center;height:100%;color:#666;font-size:18px;flex-direction:column;gap:10px}
#no-cameras .icon{font-size:48px;opacity:0.5}
</style>
</head><body>
<div id="grid"></div>
<div id="no-cameras" style="display:none">
  <div class="icon">📹</div>
  <div>No active cameras</div>
  <div style="font-size:14px;color:#555">Cameras will appear here when they join</div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
const grid=document.getElementById("grid");
const noCameras=document.getElementById("no-cameras");
let activeSlots={};
let previousSlots={};
let needsClick=true;

function isOBS(){return /OBS|obslocal|obsbrowser/i.test(navigator.userAgent);}

function slotsChanged(){
  const curr=Object.entries(activeSlots).filter(([n,id])=>id).map(([n,id])=>n+':'+id).sort().join(',');
  const prev=Object.entries(previousSlots).filter(([n,id])=>id).map(([n,id])=>n+':'+id).sort().join(',');
  return curr!==prev;
}

function render(){
  // Only re-render if slots actually changed
  if(!slotsChanged() && grid.children.length>0){
    return;
  }

  console.log("Rendering group feed - slots changed");
  previousSlots=JSON.parse(JSON.stringify(activeSlots));

  // Get all active slots
  const active=Object.entries(activeSlots).filter(([n,id])=>id).sort((a,b)=>+a[0]-(+b[0]));

  if(active.length===0){
    grid.style.display='none';
    noCameras.style.display='flex';
    return;
  }

  grid.style.display='grid';
  noCameras.style.display='none';

  // Update grid class for auto-scaling
  grid.className='';
  grid.classList.add(\`count-\${Math.min(active.length,16)}\`);

  // Clear existing content
  grid.innerHTML='';

  // Create iframe for each active slot
  active.forEach(([slotNum,streamId])=>{
    const container=document.createElement("div");
    container.className="slot-container";
    container.dataset.slot=slotNum;

    const label=document.createElement("div");
    label.className="slot-label";
    label.textContent=\`Camera \${slotNum}\`;
    container.appendChild(label);

    if(!streamId){
      const waiting=document.createElement("div");
      waiting.className="waiting";
      waiting.textContent=\`Waiting for camera \${slotNum}...\`;
      container.appendChild(waiting);
    }else{
      let url="${VDO}/?view="+encodeURIComponent(streamId)
              +"&cleanoutput=1&stats=0&scene&autostart=1&coverview&relay";
      if(!isOBS())url+="&muted=1";

      const iframe=document.createElement("iframe");
      iframe.allow="autoplay; camera; microphone; fullscreen; display-capture; encrypted-media; picture-in-picture";
      iframe.setAttribute("allowfullscreen","");
      iframe.src=url;
      container.appendChild(iframe);
    }

    grid.appendChild(container);
  });

  // Add click-to-play overlay for browsers (not OBS) - only on first render
  if(!isOBS() && needsClick && active.length>0){
    const overlay=document.createElement("div");
    overlay.id="overlay";
    overlay.innerHTML=\`
      <div class="play-btn">▶ Click to Play All Cameras</div>
      <div class="count">\${active.length} camera\${active.length===1?'':'s'} active</div>
    \`;
    overlay.onclick=()=>{
      needsClick=false;
      overlay.remove();
      // Reload all iframes to enable autoplay after user interaction
      document.querySelectorAll('.slot-container iframe').forEach(f=>{
        const oldSrc=f.src;
        f.src='';
        setTimeout(()=>f.src=oldSrc,100);
      });
    };
    document.body.appendChild(overlay);
  }
}

async function poll(){
  try{
    const j=await fetch("/api/state").then(r=>r.json());
    activeSlots=j.slots||{};
    render();
  }catch(e){console.error("Poll error:",e);}
}

poll();
const io_=io();
io_.on("state",()=>{
  console.log("State update received, refreshing...");
  poll();
});
setInterval(poll,3000);  // Poll every 3 seconds
</script></body></html>`);
});

app.get("/control",requireAuth,async(req,res)=>{
  const qr=await QRCode.toDataURL(`${PUBLIC_HOST}/join`);
  // Only show rows up to MAX_SLOTS
  const rows=[];
  for(let i=1;i<=MAX_SLOTS;i++){
    const s=SLOTS[i];
    const status=s?'<span class="badge active">Active</span>':'<span class="badge empty">Empty</span>';
    const id=s?s.streamId:'-';
    const duration=s?Math.floor((now()-s.since)/1000)+'s':'-';
    const slotUrl=`${PUBLIC_HOST}/slot/${i}`;
    rows.push(`<tr class="${s?'occupied':''}">
    <td><strong>${i}</strong></td>
    <td>${status}</td>
    <td class="stream-id">${id}</td>
    <td class="duration">${duration}</td>
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
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px">
          <h3>Camera Slots</h3>
          <div style="display:flex;gap:10px">
            <a href="/group" target="_blank" class="btn-group" style="background:#10b981;color:#fff;padding:8px 20px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500;display:inline-block;border:none;cursor:pointer">📹 View Group Feed</a>
            <button class="btn-clear-all" onclick="clearAllSlots()">Clear All Slots</button>
          </div>
        </div>
        <table id="t"><tr><th>Slot</th><th>Status</th><th>Stream ID</th><th>Duration</th><th>Slot Link</th><th>Action</th></tr>${rowsHtml}</table>
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
      if(total<1||total>50){
        showToast('Total slots must be between 1 and 50', 'error');
        return;
      }
      const res=await fetch('/api/config',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({maxSlots:total})
      });
      const j=await res.json();
      if(j.ok){
        maxSlots=j.maxSlots;
        document.getElementById('total-slots').textContent=maxSlots;
        showToast(\`Slots updated to \${maxSlots}\`, 'success');
        refresh();
      }else{
        showToast(j.error||'Failed to update settings', 'error');
      }
    }

    function copySlotUrl(url){
      navigator.clipboard.writeText(url).then(()=>{
        showToast('Link copied to clipboard', 'success');
      }).catch(err=>{
        console.error('Copy failed:',err);
        showToast('Failed to copy link', 'error');
      });
    }

    async function clearSlot(n){
      await fetch('/api/clear/'+n,{method:'POST'});
      showToast(\`Slot \${n} cleared\`, 'info');
      refresh();
    }

    async function clearAllSlots(){
      if(!confirm('Are you sure you want to clear all active slots?'))return;
      const res=await fetch('/api/clear-all',{method:'POST'});
      const data=await res.json();
      if(data.ok){
        showToast(\`Cleared \${data.cleared} slot(s)\`, 'success');
        refresh();
      }else{
        showToast('Failed to clear slots', 'error');
      }
    }

    async function refresh(){
      try{
        console.log('Refreshing slots...');
        const j=await fetch('/api/state').then(r=>r.json());
        maxSlots=j.maxSlots||maxSlots;
        let h='<tr><th>Slot</th><th>Status</th><th>Stream ID</th><th>Duration</th><th>Slot Link</th><th>Action</th></tr>';
        let activeCount=0;
        const now=Date.now();
        for(let i=1;i<=maxSlots;i++){
          const s=j.slots[i];
          if(s)activeCount++;
          const status=s?'<span class="badge active">Active</span>':'<span class="badge empty">Empty</span>';
          const id=s?s.streamId:'-';
          const duration=s?formatDuration(now-s.since):'-';
          const rowClass=s?'occupied':'';
          const disabled=s?'':'disabled';
          const slotUrl='${PUBLIC_HOST}/slot/'+i;
          h+=\`<tr class="\${rowClass}">
          <td><strong>\${i}</strong></td>
          <td>\${status}</td>
          <td class="stream-id">\${id}</td>
          <td class="duration">\${duration}</td>
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

    function formatDuration(ms){
      const seconds=Math.floor(ms/1000);
      const minutes=Math.floor(seconds/60);
      const hours=Math.floor(minutes/60);
      if(hours>0)return \`\${hours}h \${minutes%60}m\`;
      if(minutes>0)return \`\${minutes}m \${seconds%60}s\`;
      return \`\${seconds}s\`;
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
app.get("/network",requireAuth,async(req,res)=>{
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
        <p class="subtitle">All devices on the local network</p>
      </div>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <h3>Discovered Devices</h3>
        <button class="btn-refresh" id="refresh-btn" onclick="refreshDevices()">Refresh</button>
      </div>
      <table id="device-table">
        <tr><th>IP Address</th><th>MAC Address</th><th>Hostname</th></tr>
        <tr><td colspan="3" style="text-align:center;padding:20px;color:#888">Loading devices...</td></tr>
      </table>
    </div>
    <script>
    let isLoading=false;

    async function loadDevices(){
      if(isLoading){
        console.log('Already loading, skipping...');
        return;
      }
      isLoading=true;
      const btn=document.getElementById('refresh-btn');
      if(btn){
        btn.disabled=true;
        btn.textContent='Scanning...';
      }

      try{
        console.log('Loading network devices...');
        document.getElementById('device-table').innerHTML='<tr><th>IP Address</th><th>MAC Address</th><th>Hostname</th></tr><tr><td colspan="3" style="text-align:center;padding:20px;color:#888">Scanning network...</td></tr>';

        const data=await fetch('/api/network').then(r=>r.json());
        console.log('Network API response:',data);
        const devices=data.devices||[];
        let html='<tr><th>IP Address</th><th>MAC Address</th><th>Hostname</th></tr>';
        if(devices.length===0){
          let debugMsg='No devices found';
          if(data.debug){
            debugMsg+='<br><small style="color:#888">Scan method: '+(data.debug.scanMethod||'unknown')+'</small>';
            if(data.debug.arpTable){
              const arpLines=data.debug.arpTable.split('\\n').filter(l=>l.trim());
              debugMsg+='<br><small style="color:#888">ARP entries: '+arpLines.length+'</small>';
            }
            if(data.debug.unmatchedLines && data.debug.unmatchedLines.length>0){
              debugMsg+='<br><br><small style="color:#ff8888">Unmatched ARP lines ('+data.debug.unmatchedLines.length+'):</small>';
              data.debug.unmatchedLines.forEach(line=>{
                debugMsg+='<br><small style="color:#888;font-family:monospace">'+line+'</small>';
              });
            }
          }
          html+=\`<tr><td colspan="3" style="text-align:center;padding:20px;color:#888;line-height:1.8">\${debugMsg}</td></tr>\`;
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
        document.getElementById('device-table').innerHTML='<tr><th>IP Address</th><th>MAC Address</th><th>Hostname</th></tr><tr><td colspan="3" style="text-align:center;padding:20px;color:#ef4444">Error loading devices: '+e.message+'</td></tr>';
      }finally{
        isLoading=false;
        if(btn){
          btn.disabled=false;
          btn.textContent='Refresh';
        }
      }
    }

    function refreshDevices(){
      console.log('Refresh button clicked');
      loadDevices();
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

    // Auto-refresh based on settings (default 5 minutes)
    const refreshInterval = ${SETTINGS.networkRefreshInterval} * 60 * 1000;
    setInterval(()=>{
      console.log('Auto-refreshing network devices...');
      loadDevices();
    }, refreshInterval);
    </script>
  `;
  res.send(dashboardLayout('Network',content));
});

// Debug page
app.get("/debug",requireAuth,async(req,res)=>{
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
app.get("/guide",requireAuth,async(req,res)=>{
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

// Settings page
app.get("/settings",requireAuth,async(req,res)=>{
  const content=`
    <div class="header">
      <div class="header-title">
        <h1>Settings</h1>
        <p class="subtitle">Configure system settings</p>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:20px">Authentication</h3>
      <form id="auth-form" onsubmit="saveAuth(event)">
        <div class="form-group">
          <label for="username">Username</label>
          <input type="text" id="username" name="username" placeholder="admin" minlength="3" required>
          <small>Minimum 3 characters</small>
        </div>
        <div class="form-group">
          <label for="password">New Password</label>
          <input type="password" id="password" name="password" placeholder="Leave blank to keep current" minlength="6">
          <small>Minimum 6 characters (leave blank to keep current)</small>
        </div>
        <div class="form-group">
          <label for="resetPin">Reset PIN</label>
          <input type="text" id="resetPin" name="resetPin" placeholder="898989" pattern="[0-9]{6}" maxlength="6" required>
          <small>6-digit PIN for password recovery</small>
        </div>
        <button type="submit" class="btn-save">Save Authentication Settings</button>
      </form>
    </div>
    <div class="card">
      <h3 style="margin-bottom:20px">Video & Network Settings</h3>
      <form id="settings-form" onsubmit="saveSettings(event)">
        <div class="form-group">
          <label for="bitrate">Global Bitrate (kbps)</label>
          <input type="number" id="bitrate" name="bitrate" min="500" max="10000" value="${SETTINGS.bitrate}" required>
          <small>Applied to all new camera connections (500-10000 kbps)</small>
        </div>
        <div class="form-group">
          <label for="networkRefresh">Network Auto-Refresh Interval (minutes)</label>
          <input type="number" id="networkRefresh" name="networkRefresh" min="1" max="60" value="${SETTINGS.networkRefreshInterval}" required>
          <small>How often to auto-refresh the network devices page (1-60 minutes)</small>
        </div>
        <button type="submit" class="btn-save">Save Video & Network Settings</button>
      </form>
    </div>
    <script>
    // Load current username and PIN
    document.getElementById('username').value = '${SETTINGS.username}';
    document.getElementById('resetPin').value = '${SETTINGS.resetPin}';

    async function saveAuth(e) {
      e.preventDefault();
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const resetPin = document.getElementById('resetPin').value;

      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({username, password: password || undefined, resetPin})
        });
        const data = await res.json();
        if(data.ok) {
          showToast('Authentication settings saved successfully', 'success');
          document.getElementById('password').value = ''; // Clear password field
        } else {
          showToast('Failed to save settings', 'error');
        }
      } catch(e) {
        showToast('Error: ' + e.message, 'error');
      }
    }

    async function saveSettings(e) {
      e.preventDefault();
      const bitrate = parseInt(document.getElementById('bitrate').value);
      const networkRefreshInterval = parseInt(document.getElementById('networkRefresh').value);

      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({bitrate, networkRefreshInterval})
        });
        const data = await res.json();
        if(data.ok) {
          showToast('Settings saved successfully', 'success');
        } else {
          showToast('Failed to save settings', 'error');
        }
      } catch(e) {
        showToast('Error: ' + e.message, 'error');
      }
    }
    </script>
  `;
  res.send(dashboardLayout('Settings',content));
});

// Activity Log page
app.get("/activity",requireAuth,async(req,res)=>{
  const content=`
    <div class="header">
      <div class="header-title">
        <h1>Activity Log</h1>
        <p class="subtitle">Track camera connections and system events</p>
      </div>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <h3>Recent Activity</h3>
        <button class="btn-refresh" onclick="loadActivity()">Refresh</button>
      </div>
      <div id="activity-container">
        <p style="text-align:center;color:#888;padding:20px">Loading...</p>
      </div>
    </div>
    <script>
    async function loadActivity() {
      try {
        const data = await fetch('/api/activity?limit=100').then(r => r.json());
        const container = document.getElementById('activity-container');

        if(!data.logs || data.logs.length === 0) {
          container.innerHTML = '<p style="text-align:center;color:#888;padding:20px">No activity recorded yet</p>';
          return;
        }

        let html = '';
        data.logs.forEach(log => {
          const date = new Date(log.timestamp);
          const timeStr = date.toLocaleString();
          html += \`<div class="activity-entry \${log.type}">
            <div class="activity-time">\${timeStr}\${log.slot ? ' - Slot ' + log.slot : ''}</div>
            <div class="activity-message">\${log.message}</div>
          </div>\`;
        });
        container.innerHTML = html;
      } catch(e) {
        document.getElementById('activity-container').innerHTML =
          '<p style="text-align:center;color:#ef4444;padding:20px">Error loading activity log</p>';
      }
    }

    loadActivity();

    // Listen for real-time activity updates
    const socket = io();
    socket.on('activity', (entry) => {
      const container = document.getElementById('activity-container');
      const date = new Date(entry.timestamp);
      const timeStr = date.toLocaleString();
      const html = \`<div class="activity-entry \${entry.type}">
        <div class="activity-time">\${timeStr}\${entry.slot ? ' - Slot ' + entry.slot : ''}</div>
        <div class="activity-message">\${entry.message}</div>
      </div>\`;
      container.insertAdjacentHTML('afterbegin', html);

      // Keep only last 100 entries visible
      const entries = container.querySelectorAll('.activity-entry');
      if(entries.length > 100) {
        entries[entries.length - 1].remove();
      }
    });
    </script>
  `;
  res.send(dashboardLayout('Activity',content));
});

// Camera Control page
app.get("/camera-control",requireAuth,async(req,res)=>{
  const content=`
    <div class="header">
      <div class="header-title">
        <h1>Camera Control</h1>
        <p class="subtitle">Control OBS Camera app via remote interface</p>
      </div>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;gap:10px;flex-wrap:wrap">
        <h3>Camera Management</h3>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <input type="text" id="custom-subnet" placeholder="Optional: 192.168.4 or 10.0.1"
            style="padding:8px 12px;background:#252540;border:1px solid #667eea;color:#fff;border-radius:6px;min-width:180px">
          <button class="btn-refresh" id="scan-btn" onclick="scanWithCustomSubnet()">Auto-Scan Network</button>
          <button class="btn-apply" onclick="showAddCameraForm()" style="width:auto;padding:8px 20px">+ Add Camera</button>
        </div>
      </div>
      <div style="margin-bottom:15px;padding:10px;background:#1e1e35;border-radius:6px;font-size:0.9em;color:#888">
        💡 <strong>Tip:</strong> <strong>Manual addition recommended!</strong> Enter your iPhone IP below to add instantly, or use custom subnet scan (e.g., "192.168.4") for faster targeted scanning.
      </div>
      <div style="margin-bottom:15px;padding:10px;background:#252540;border-left:3px solid #10b981;border-radius:6px;font-size:0.9em;color:#e0e0e0">
        📱 <strong>Important:</strong> In the OBS Camera app, set the remote control mode to <strong>Auto</strong> (not Manual) for the controls below to work properly.
      </div>

      <div id="add-camera-form" style="display:none;margin-bottom:20px;padding:20px;background:#252540;border-radius:8px">
        <h4 style="margin-bottom:15px">Add Camera Manually</h4>
        <div style="display:flex;gap:15px;flex-wrap:wrap">
          <div style="flex:1;min-width:200px">
            <label style="display:block;margin-bottom:5px;color:#e0e0e0">Camera Name</label>
            <input type="text" id="camera-name" placeholder="e.g. iPhone 1" style="width:100%;padding:10px;background:#1a1a2e;border:1px solid #667eea;color:#fff;border-radius:6px">
          </div>
          <div style="flex:1;min-width:200px">
            <label style="display:block;margin-bottom:5px;color:#e0e0e0">IP Address</label>
            <input type="text" id="camera-ip" placeholder="e.g. 192.168.4.10" style="width:100%;padding:10px;background:#1a1a2e;border:1px solid #667eea;color:#fff;border-radius:6px">
          </div>
          <div style="display:flex;align-items:flex-end;gap:10px">
            <button class="btn-save" onclick="addCamera()" style="padding:10px 24px;margin:0">Add</button>
            <button class="btn-clear" onclick="hideAddCameraForm()" style="padding:10px 24px;margin:0">Cancel</button>
          </div>
        </div>
      </div>

      <div id="scan-results" style="display:none;margin-bottom:20px;padding:15px;background:#1e1e35;border-radius:8px;border-left:3px solid #10b981">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <strong>Scan Results:</strong> <span id="scan-count">0</span> cameras found
          </div>
          <button onclick="addAllScannedCameras()" class="btn-apply" style="padding:6px 16px;margin:0;width:auto">Add All</button>
        </div>
        <div id="scan-list" style="margin-top:10px"></div>
      </div>
    </div>

    <div id="cameras-container" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(450px,1fr));gap:20px">
      <div style="text-align:center;padding:40px;color:#888;grid-column:1/-1">
        No cameras added yet. Click "Auto-Scan Network" or "+ Add Camera" to get started.
      </div>
    </div>

    <style>
    .camera-card{background:#1a1a2e;border-radius:12px;padding:20px;box-shadow:0 4px 20px rgba(0,0,0,0.3)}
    .camera-card.connected{border:2px solid #10b981}
    .camera-card.disconnected{border:2px solid #374151}
    .camera-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:15px;padding-bottom:15px;border-bottom:1px solid #2a2a3e}
    .camera-title{font-size:1.2em;font-weight:600;color:#fff}
    .camera-status{font-size:0.85em;padding:4px 12px;border-radius:12px;font-weight:600}
    .camera-status.connected{background:#10b981;color:#fff}
    .camera-status.disconnected{background:#374151;color:#9ca3af}
    .camera-controls{display:flex;flex-direction:column;gap:15px}
    .control-group{background:#252540;padding:15px;border-radius:8px}
    .control-group h4{margin-bottom:10px;color:#667eea;font-size:0.95em}
    .control-row{display:flex;gap:10px;align-items:center;margin-bottom:10px}
    .control-row:last-child{margin-bottom:0}
    .control-label{flex:0 0 120px;color:#e0e0e0;font-size:0.9em}
    .control-input{flex:1;padding:8px;background:#1a1a2e;border:1px solid #667eea;color:#fff;border-radius:6px;font-size:0.9em}
    .control-input:focus{outline:none;border-color:#764ba2}
    .btn-mini{padding:6px 12px;font-size:0.85em;border-radius:6px;border:none;cursor:pointer;font-weight:500;transition:all 0.2s}
    .btn-connect{background:#10b981;color:#fff}
    .btn-connect:hover{background:#059669}
    .btn-disconnect{background:#f59e0b;color:#fff}
    .btn-disconnect:hover{background:#d97706}
    .btn-remove{background:#ef4444;color:#fff}
    .btn-remove:hover{background:#dc2626}
    .toggle-btn{background:#667eea;color:#fff;padding:8px 16px;border-radius:6px;border:none;cursor:pointer;font-weight:500;transition:all 0.2s}
    .toggle-btn.active{background:#10b981}
    .toggle-btn:hover{opacity:0.9}
    </style>

    <script>
    const socket=io();
    let cameras=[];
    let scannedCameras=[];

    // Debounce function to prevent too many rapid updates
    function debounce(func, wait) {
      let timeout;
      return function executedFunction(...args) {
        const later = () => {
          clearTimeout(timeout);
          func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
      };
    }

    // Create debounced version of updateSetting with 300ms delay
    const debouncedUpdateSetting = debounce((cameraId, key, value) => {
      updateSetting(cameraId, key, value);
    }, 300);

    const debouncedUpdateFocusPosition = debounce((cameraId, position) => {
      updateFocusPosition(cameraId, position);
    }, 300);

    socket.on('cameras',(data)=>{
      cameras=data.cameras;
      renderCameras();
    });

    socket.on('camera-update',(data)=>{
      const camera=cameras.find(c=>c.id===data.cameraId);
      if(camera){
        camera.settings=data.settings;
        renderCameras();
      }
    });

    async function loadCameras(){
      try{
        const data=await fetch('/api/cameras').then(r=>r.json());
        cameras=data.cameras;
        renderCameras();
      }catch(e){
        console.error('Error loading cameras:',e);
        showToast('Error loading cameras','error');
      }
    }

    function renderCameras(){
      const container=document.getElementById('cameras-container');
      if(cameras.length===0){
        container.innerHTML='<div style="text-align:center;padding:40px;color:#888;grid-column:1/-1">No cameras added yet. Click "Auto-Scan Network" or "+ Add Camera" to get started.</div>';
        return;
      }

      let html='';
      cameras.forEach(camera=>{
        const connected=camera.connected;
        const statusClass=connected?'connected':'disconnected';
        const statusText=connected?'Connected':'Disconnected';

        html+=\`<div class="camera-card \${statusClass}">
          <div class="camera-header">
            <div class="camera-title">\${camera.name}</div>
            <span class="camera-status \${statusClass}">\${statusText}</span>
          </div>
          <div style="margin-bottom:15px;color:#888;font-size:0.9em">
            <div>IP: \${camera.ip}</div>
            \${camera.lastSeen?'<div style="font-size:0.85em">Last seen: '+new Date(camera.lastSeen).toLocaleString()+'</div>':''}
          </div>
          <div style="display:flex;gap:10px;margin-bottom:15px">
            \${!connected?
              '<button class="btn-mini btn-connect" onclick="connectCamera(\\''+camera.id+'\\')">Connect</button>':
              '<button class="btn-mini btn-disconnect" onclick="disconnectCamera(\\''+camera.id+'\\')">Disconnect</button>'
            }
            <button class="btn-mini btn-remove" onclick="removeCamera('\${camera.id}')">Remove</button>
          </div>
          \${connected && camera.settings?renderCameraControls(camera):'<div style="text-align:center;padding:20px;color:#888">Connect to view controls</div>'}
        </div>\`;
      });

      container.innerHTML=html;
    }

    function renderCameraControls(camera){
      const s=camera.settings;
      if(!s)return'';

      return \`
        <div class="camera-controls">
          <div class="control-group">
            <h4>Camera & Quality</h4>
            <div class="control-row">
              <span class="control-label">Camera:</span>
              <select class="control-input" onchange="updateCameraSetting('\${camera.id}','selectedCamera',this.value)">
                <option value="front" \${s.selectedCamera==='front'?'selected':''}>Front</option>
                <option value="back" \${s.selectedCamera==='back'?'selected':''}>Back</option>
                <option value="ultra-wide" \${s.selectedCamera==='ultra-wide'?'selected':''}>Ultra Wide</option>
                <option value="wide" \${s.selectedCamera==='wide'?'selected':''}>Wide</option>
                <option value="telephoto" \${s.selectedCamera==='telephoto'?'selected':''}>Telephoto</option>
              </select>
            </div>
            <div style="font-size:0.85em;color:#888;margin-top:5px">
              Available cameras depend on iPhone model. If switching doesn't work, the camera may not have that lens.
            </div>
            <div class="control-row">
              <span class="control-label">Resolution:</span>
              <select class="control-input" onchange="updateSetting('\${camera.id}','resolution',this.value)">
                <option value="1920x1080" \${s.resolution==='1920x1080'?'selected':''}>1920x1080</option>
                <option value="1280x720" \${s.resolution==='1280x720'?'selected':''}>1280x720</option>
                <option value="3840x2160" \${s.resolution==='3840x2160'?'selected':''}>3840x2160 (4K)</option>
              </select>
            </div>
            <div class="control-row">
              <span class="control-label">Framerate:</span>
              <select class="control-input" onchange="updateSetting('\${camera.id}','framerate',this.value)">
                <option value="24" \${s.framerate==='24'?'selected':''}>24 fps</option>
                <option value="30" \${s.framerate==='30'?'selected':''}>30 fps</option>
                <option value="60" \${s.framerate==='60'?'selected':''}>60 fps</option>
              </select>
            </div>
          </div>

          <div class="control-group">
            <h4>Zoom & Torch</h4>
            <div class="control-row">
              <span class="control-label">Zoom:</span>
              <input type="range" class="control-input" min="1" max="10" step="0.1" value="\${s.zoomLevel||1}"
                oninput="this.nextElementSibling.textContent=parseFloat(this.value).toFixed(1)+'x';debouncedUpdateSetting('\${camera.id}','zoomLevel',parseFloat(this.value))">
              <span style="min-width:40px;color:#888">\${(s.zoomLevel||1).toFixed(1)}x</span>
            </div>
            <div class="control-row">
              <span class="control-label">Torch:</span>
              <button class="toggle-btn \${s.isTorchEnabled?'active':''}"
                onclick="updateSetting('\${camera.id}','isTorchEnabled',\${!s.isTorchEnabled})">
                \${s.isTorchEnabled?'ON':'OFF'}
              </button>
            </div>
          </div>

          <div class="control-group">
            <h4>White Balance</h4>
            <div class="control-row">
              <span class="control-label">Mode:</span>
              <button class="toggle-btn \${s.isAutomaticWhiteBalanceModeEnabled?'active':''}"
                onclick="updateSetting('\${camera.id}','isAutomaticWhiteBalanceModeEnabled',\${!s.isAutomaticWhiteBalanceModeEnabled})">
                \${s.isAutomaticWhiteBalanceModeEnabled?'Auto':'Manual'}
              </button>
            </div>
            \${!s.isAutomaticWhiteBalanceModeEnabled?\`
            <div class="control-row">
              <span class="control-label">Temperature:</span>
              <input type="range" class="control-input" min="1800" max="8000" step="100" value="\${s.temperature||5000}"
                oninput="this.nextElementSibling.textContent=parseInt(this.value)+'K';debouncedUpdateSetting('\${camera.id}','temperature',parseInt(this.value))">
              <span style="min-width:50px;color:#888">\${s.temperature||5000}K</span>
            </div>\`:''}
          </div>

          <div class="control-group">
            <h4>Focus</h4>
            <div class="control-row">
              <span class="control-label">Mode:</span>
              <select class="control-input" onchange="updateFocusMode('\${camera.id}',this.value)">
                <option value="auto" \${s.focusConfiguration?.focusMode==='auto'?'selected':''}>Auto</option>
                <option value="manual" \${s.focusConfiguration?.focusMode==='manual'?'selected':''}>Manual</option>
              </select>
            </div>
            \${s.focusConfiguration?.focusMode==='manual'?\`
            <div class="control-row">
              <span class="control-label">Position:</span>
              <input type="range" class="control-input" min="0" max="1" step="0.01" value="\${s.focusConfiguration?.lensPosition||0.5}"
                oninput="this.nextElementSibling.textContent=(parseFloat(this.value)*100).toFixed(0)+'%';debouncedUpdateFocusPosition('\${camera.id}',parseFloat(this.value))">
              <span style="min-width:50px;color:#888">\${((s.focusConfiguration?.lensPosition||0.5)*100).toFixed(0)}%</span>
            </div>\`:''}
          </div>

          \${s.batteryState?\`
          <div style="padding:10px;background:#252540;border-radius:8px;text-align:center;color:#888;font-size:0.9em">
            🔋 Battery: \${(s.batteryState.level*100).toFixed(0)}%
          </div>\`:''}
        </div>
      \`;
    }

    function scanWithCustomSubnet(){
      const customSubnet=document.getElementById('custom-subnet').value.trim();
      scanForCameras(customSubnet||null);
    }

    async function scanForCameras(customSubnet=null){
      const btn=document.getElementById('scan-btn');
      btn.disabled=true;
      btn.textContent='Scanning...';

      try{
        const body=customSubnet?{customSubnet}:{};
        const data=await fetch('/api/cameras/scan',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(body)
        }).then(r=>r.json());
        scannedCameras=data.cameras||[];

        // Show which subnets were scanned
        const subnetsScanned=data.scannedSubnets?data.scannedSubnets.join(', '):'unknown';
        console.log('Scanned subnets:',subnetsScanned);

        if(scannedCameras.length===0){
          showToast(\`No cameras found. Scanned: \${subnetsScanned}\`,'info');
          document.getElementById('scan-results').style.display='none';
        }else{
          document.getElementById('scan-count').textContent=scannedCameras.length;
          let html='';
          scannedCameras.forEach((cam,idx)=>{
            html+=\`<div style="padding:8px 0;border-top:1px solid #2a2a3e">
              <strong>\${cam.ip}</strong>
              <button class="btn-mini btn-connect" onclick="addScannedCamera(\${idx})" style="margin-left:10px">Add</button>
            </div>\`;
          });
          document.getElementById('scan-list').innerHTML=html;
          document.getElementById('scan-results').style.display='block';
          showToast(\`Found \${scannedCameras.length} camera(s) on \${subnetsScanned}\`,'success');
        }
      }catch(e){
        console.error('Scan error:',e);
        showToast('Error scanning network','error');
      }finally{
        btn.disabled=false;
        btn.textContent='Auto-Scan Network';
      }
    }

    async function addScannedCamera(index){
      const cam=scannedCameras[index];
      try{
        const res=await fetch('/api/cameras/add',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ip:cam.ip,name:cam.name})
        });
        const data=await res.json();
        if(data.ok){
          showToast(\`Camera added: \${cam.ip}\`,'success');
          scannedCameras.splice(index,1);
          if(scannedCameras.length===0){
            document.getElementById('scan-results').style.display='none';
          }
          loadCameras();
        }else{
          showToast(data.error||'Failed to add camera','error');
        }
      }catch(e){
        console.error('Error adding camera:',e);
        showToast('Error adding camera','error');
      }
    }

    async function addAllScannedCameras(){
      for(const cam of scannedCameras){
        try{
          await fetch('/api/cameras/add',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ip:cam.ip,name:cam.name})
          });
        }catch(e){
          console.error('Error adding camera:',e);
        }
      }
      showToast(\`Added \${scannedCameras.length} camera(s)\`,'success');
      scannedCameras=[];
      document.getElementById('scan-results').style.display='none';
      loadCameras();
    }

    function showAddCameraForm(){
      document.getElementById('add-camera-form').style.display='block';
      document.getElementById('camera-name').focus();
    }

    function hideAddCameraForm(){
      document.getElementById('add-camera-form').style.display='none';
      document.getElementById('camera-name').value='';
      document.getElementById('camera-ip').value='';
    }

    async function addCamera(){
      const name=document.getElementById('camera-name').value;
      const ip=document.getElementById('camera-ip').value;

      if(!ip){
        showToast('IP address is required','error');
        return;
      }

      try{
        const res=await fetch('/api/cameras/add',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ip,name})
        });
        const data=await res.json();
        if(data.ok){
          showToast('Camera added successfully','success');
          hideAddCameraForm();
          loadCameras();
        }else{
          showToast(data.error||'Failed to add camera','error');
        }
      }catch(e){
        console.error('Error adding camera:',e);
        showToast('Error adding camera','error');
      }
    }

    async function connectCamera(id){
      try{
        const res=await fetch(\`/api/cameras/\${id}/connect\`,{method:'POST'});
        const data=await res.json();
        if(data.ok){
          showToast('Connecting to camera...','info');
        }else{
          showToast(data.error||'Failed to connect','error');
        }
      }catch(e){
        console.error('Error connecting:',e);
        showToast('Error connecting to camera','error');
      }
    }

    async function disconnectCamera(id){
      const camera=cameras.find(c=>c.id===id);
      if(!camera)return;
      // Note: Closing from server side would require additional API endpoint
      showToast('Disconnect camera by closing the app','info');
    }

    async function removeCamera(id){
      if(!confirm('Remove this camera?'))return;
      try{
        const res=await fetch(\`/api/cameras/\${id}\`,{method:'DELETE'});
        const data=await res.json();
        if(data.ok){
          showToast('Camera removed','success');
          loadCameras();
        }else{
          showToast(data.error||'Failed to remove camera','error');
        }
      }catch(e){
        console.error('Error removing camera:',e);
        showToast('Error removing camera','error');
      }
    }

    async function updateCameraSetting(cameraId,key,value){
      const camera=cameras.find(c=>c.id===cameraId);
      if(!camera||!camera.settings)return;

      console.log(\`Changing \${key} from \${camera.settings[key]} to \${value}\`);

      const newSettings={...camera.settings,[key]:value};

      try{
        await fetch(\`/api/cameras/\${cameraId}/command\`,{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(newSettings)
        });
        camera.settings[key]=value;
        renderCameras();
        showToast(\`Camera switched to \${value}\`,'info');
      }catch(e){
        console.error('Error updating camera:',e);
        showToast('Error switching camera','error');
      }
    }

    async function updateSetting(cameraId,key,value){
      const camera=cameras.find(c=>c.id===cameraId);
      if(!camera||!camera.settings)return;

      const newSettings={...camera.settings,[key]:value};

      try{
        await fetch(\`/api/cameras/\${cameraId}/command\`,{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(newSettings)
        });
        camera.settings[key]=value;
        renderCameras();
      }catch(e){
        console.error('Error updating setting:',e);
        showToast('Error updating setting','error');
      }
    }

    async function updateFocusMode(cameraId,mode){
      const camera=cameras.find(c=>c.id===cameraId);
      if(!camera||!camera.settings)return;

      const newSettings={
        ...camera.settings,
        focusConfiguration:{
          ...(camera.settings.focusConfiguration||{}),
          focusMode:mode
        }
      };

      try{
        await fetch(\`/api/cameras/\${cameraId}/command\`,{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(newSettings)
        });
        camera.settings.focusConfiguration=newSettings.focusConfiguration;
        renderCameras();
      }catch(e){
        console.error('Error updating focus mode:',e);
        showToast('Error updating focus mode','error');
      }
    }

    async function updateFocusPosition(cameraId,position){
      const camera=cameras.find(c=>c.id===cameraId);
      if(!camera||!camera.settings)return;

      const newSettings={
        ...camera.settings,
        focusConfiguration:{
          ...(camera.settings.focusConfiguration||{}),
          lensPosition:position
        }
      };

      try{
        await fetch(\`/api/cameras/\${cameraId}/command\`,{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(newSettings)
        });
        camera.settings.focusConfiguration=newSettings.focusConfiguration;
        renderCameras();
      }catch(e){
        console.error('Error updating focus position:',e);
        showToast('Error updating focus position','error');
      }
    }

    loadCameras();
    </script>
  `;
  res.send(dashboardLayout('Camera Control',content));
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
