// admin-script.js
import { auth, db as mainDb } from "./firebase-config.js";
import { initializeApp, getApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { getDatabase, ref, set, onValue, serverTimestamp, remove, update, push, get, child, increment } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";

let db = mainDb;
let globalKeysData = [];
let globalSecondaryFirebases = [];
let keysChartInstance = null;
let cleanupInterval = null;
let saveTimeout = null;
let allDbKeys = {}; 
let activeMirrorListeners = {}; 

// MEMORY CACHE
window.adminLogsCache = {}; 

window.showToast = function(msg, isError = false) {
    const toast = document.getElementById('toastNotice');
    if (!toast) return;
    toast.innerText = msg;
    toast.className = '';
    if (isError) toast.classList.add('error');
    toast.classList.add('show');
    setTimeout(() => { toast.classList.remove('show'); }, 3000);
};

window.logoutAdmin = function() {
    if (confirm('Are you sure you want to logout?')) {
        signOut(auth).then(() => {
            localStorage.removeItem('admin_session');
            localStorage.removeItem('saved_admin_email');
            localStorage.removeItem('saved_admin_pass');
            window.location.href = 'index.html';
        }).catch(() => { window.location.href = 'index.html'; });
    }
};

// BULLETPROOF DATE FORMATTER
function formatDate(ts) {
    if (!ts || typeof ts === 'object') return "Just Now"; 
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "Just Now";
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// ----------------------------------------------------
// LOG ACTIVITY ENGINE
// ----------------------------------------------------
async function logAdminActivity(action, key, undoDataObj, type) {
    if (!db) return;
    try {
        await push(ref(db, 'AdminLogs'), {
            action: action,
            key: key,
            type: type,
            undoData: JSON.stringify(undoDataObj || {}),
            time: serverTimestamp(),
            undone: false
        });
    } catch (e) { console.error("Log error:", e); }
}

// ----------------------------------------------------
// UNDO ENGINE (TRUE PREVIOUS STATE + MULTI-DB)
// ----------------------------------------------------
window.executeUndo = async function(logId) {
    if (!db) { showToast("DB not ready", true); return; }
    if (!confirm("Undo this action globally (on all DBs)?")) return;
    
    const logItem = window.adminLogsCache[logId];
    if (!logItem) { showToast("Log data missing!", true); return; }

    try {
        const type = logItem.type;
        const undoDataStr = logItem.undoData;
        const undoData = typeof undoDataStr === 'string' ? JSON.parse(undoDataStr) : undoDataStr;
        
        if (type === 'DELETE_KEY') {
            await set(ref(db, 'ActiveUserKeys/' + undoData.key), undoData.data);
            globalSecondaryFirebases.forEach(fb => set(ref(fb.db, 'ActiveUserKeys/' + undoData.key), undoData.data).catch(()=>{}));
            showToast("Key Restored Globally!");
        } 
        else if (type === 'CREATE_KEY') {
            await remove(ref(db, 'ActiveUserKeys/' + undoData.key));
            globalSecondaryFirebases.forEach(fb => remove(ref(fb.db, 'ActiveUserKeys/' + undoData.key)).catch(()=>{}));
            showToast("Key Generation Undone!");
        } 
        else if (type === 'EDIT_KEY') {
            const updates = { durationHours: undoData.oldHours };
            await update(ref(db, 'ActiveUserKeys/' + undoData.key), updates);
            globalSecondaryFirebases.forEach(fb => update(ref(fb.db, 'ActiveUserKeys/' + undoData.key), updates).catch(()=>{}));
            showToast("Key Time Reverted Globally!");
        } 
        else if (type === 'RESET_KEY') {
            const updates = { boundDeviceId: undoData.oldDevice, isUsed: true };
            await update(ref(db, 'ActiveUserKeys/' + undoData.key), updates);
            globalSecondaryFirebases.forEach(fb => update(ref(fb.db, 'ActiveUserKeys/' + undoData.key), updates).catch(()=>{}));
            showToast("Device Re-bound Globally!");
        } 
        else if (type === 'BAN_DEVICE') {
            await remove(ref(db, 'BannedDevices/' + undoData.deviceId));
            if (undoData.keyData) {
                await set(ref(db, 'ActiveUserKeys/' + undoData.key), undoData.keyData);
                globalSecondaryFirebases.forEach(fb => set(ref(fb.db, 'ActiveUserKeys/' + undoData.key), undoData.keyData).catch(()=>{}));
            }
            showToast("Device Unbanned & Key Restored!");
        } 
        else if (type === 'SETTINGS') {
            // APPLYING EXACT PREVIOUS STATE
            if(undoData.oldSettings) {
                await update(ref(db, 'SystemSettings'), undoData.oldSettings);
                showToast("Settings Reverted to previous state!");
            }
        }
        
        await update(ref(db, 'AdminLogs/' + logId), { undone: true });
        await logAdminActivity("Used Undo Action", `Reverted ${type}`, {}, "UNDO");
    } catch (e) { 
        showToast("Error: " + e.message, true); 
        console.error("Undo Error:", e);
    }
};

window.clearActivityLog = async function() {
    if (!db) { showToast("DB not ready", true); return; }
    if (confirm("Clear all history?")) {
        try { await remove(ref(db, 'AdminLogs')); showToast("History Cleared!"); } 
        catch (e) { showToast("Error: " + e.message, true); }
    }
};

function renderGraph(dailyData) {
    const canvas = document.getElementById('keysChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const labels = [], counts = [];
    for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        labels.push(`${d.getDate()}/${d.getMonth()+1}`);
        counts.push(dailyData[ds] || 0);
    }
    if (keysChartInstance) keysChartInstance.destroy();
    keysChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Keys Generated',
                data: counts,
                borderColor: '#6366f1',
                backgroundColor: 'rgba(99,102,241,0.2)',
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointRadius: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#a1a1aa' }, grid: { display: false } },
                y: { ticks: { color: '#a1a1aa', stepSize: 1 }, grid: { color: '#27272a' }, beginAtZero: true }
            }
        }
    });
}

function autoSaveDefaultSettings() {
    if (!db) return;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
        const val = parseInt(document.getElementById('customTimeVal').value);
        const type = document.getElementById('customTimeType').value;
        const tier = document.getElementById('keyTypeInput').value;
        const lifetime = document.getElementById('lifetimeCheck').checked;
        
        if (!val || val <= 0) return;
        
        const hours = type === 'days' ? val * 24 : val;
        const duration = lifetime ? 99999 : hours;
        
        try {
            // STEP 1: FETCH TRUE PREVIOUS STATE BEFORE SAVING
            const snap = await get(ref(db, 'SystemSettings'));
            const oldDB = snap.exists() ? snap.val() : {};
            
            const oldSet = {
                defaultKeyDuration: oldDB.defaultKeyDuration !== undefined ? oldDB.defaultKeyDuration : 24,
                defaultKeyTier: oldDB.defaultKeyTier !== undefined ? oldDB.defaultKeyTier : 'normal',
                defaultKeyLifetime: oldDB.defaultKeyLifetime !== undefined ? oldDB.defaultKeyLifetime : false
            };
            
            // STEP 2: UPDATE
            await update(ref(db, 'SystemSettings'), {
                defaultKeyDuration: duration,
                defaultKeyTier: tier,
                defaultKeyLifetime: lifetime
            });
            
            // STEP 3: LOG WITH TRUE PREVIOUS STATE
            await logAdminActivity("Auto-Saved Settings", `New Default - Tier: ${tier}, Duration: ${duration}h`, { oldSettings: oldSet }, "SETTINGS");
            
            document.getElementById('saveDefaultDurationBtn').innerHTML = '✅ Saved';
            setTimeout(() => { document.getElementById('saveDefaultDurationBtn').innerHTML = '💾 Auto-Save'; }, 1500);
        } catch (e) { console.error("Auto-save error:", e); }
    }, 500);
}

function attachAutoSaveListeners() {
    const fields = ['customTimeVal', 'customTimeType', 'keyTypeInput', 'lifetimeCheck'];
    fields.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.removeEventListener('change', autoSaveDefaultSettings);
            el.addEventListener('change', autoSaveDefaultSettings);
        }
    });
}

function renderUnifiedKeys() {
    const tbody = document.getElementById('tableBody');
    const usersBody = document.getElementById('usersBody');
    let total = 0, used = 0;
    
    let mergedKeys = {};
    for (let source in allDbKeys) {
        let keysObj = allDbKeys[source];
        for (let k in keysObj) {
            if (!mergedKeys[k]) {
                mergedKeys[k] = { ...keysObj[k] };
            } else {
                if (keysObj[k].boundDeviceId && keysObj[k].boundDeviceId !== "NONE") {
                    mergedKeys[k].boundDeviceId = keysObj[k].boundDeviceId;
                    mergedKeys[k].isUsed = keysObj[k].isUsed;
                }
            }
        }
    }

    globalKeysData = [];
    for (let k in mergedKeys) { globalKeysData.push({ k: k, d: mergedKeys[k] }); }
    globalKeysData.sort((a, b) => (b.d.createdAt || 0) - (a.d.createdAt || 0));

    if (globalKeysData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:30px;">Empty Database</td></tr>';
        usersBody.innerHTML = '<tr><td colspan="3" style="text-align:center;">No active connections</td></tr>';
        document.getElementById('totalKeys').innerText = 0;
        document.getElementById('usedKeys').innerText = 0;
        return;
    }

    let tHTML = '';
    let uHTML = '';

    globalKeysData.forEach(item => {
        total++;
        const now = Date.now();
        const cr = item.d.createdAt || now;
        const ex = cr + (item.d.durationHours * 60 * 60 * 1000);
        const isEx = item.d.durationHours !== 99999 && now > ex;
        const isBd = item.d.boundDeviceId && item.d.boundDeviceId !== "NONE";
        if (isBd) used++;

        const badge = item.k.includes('VIP') ? `<span class="badge badge-vip">VIP</span>` : `<span class="badge badge-normal">NORM</span>`;
        const note = item.d.note ? `<div style="color:#a1a1aa;font-size:11px;margin-top:5px;"><i class="fa-solid fa-tag"></i> ${item.d.note}</div>` : '';

        tHTML += `<tr>
            <td><div class="key-code">${item.k}</div>${badge} ${isEx ? '<span class="badge" style="background:#ef4444;color:#fff;">EXP</span>' : ''}${note}</td>
            <td>
                <div style="color:#e4e4e7;font-size:13px;"><i class="fa-solid fa-clock" style="color:#a1a1aa;"></i> ${item.d.durationHours === 99999 ? 'Lifetime' : item.d.durationHours + 'h'}</div>
                <div style="color:#71717a;font-size:11px;">Cr: ${formatDate(cr)}</div>
                <div style="color:#71717a;font-size:11px;">Ex: ${item.d.durationHours === 99999 ? 'Never' : formatDate(ex)}</div>
            </td>
            <td><div style="color:${isBd ? '#34d399' : '#71717a'};font-family:monospace;">${isBd ? item.d.boundDeviceId : 'Unlinked'}</div></td>
            <td>
                <div style="display:flex;gap:5px;">
                    <button class="action-icon icon-copy" data-key="${item.k}"><i class="fa-regular fa-copy"></i></button>
                    <button class="action-icon icon-edit" data-key="${item.k}"><i class="fa-solid fa-pen"></i></button>
                    ${isBd ? `<button class="action-icon icon-reset" data-key="${item.k}"><i class="fa-solid fa-unlock"></i></button>` : ''}
                    <button class="action-icon icon-del" data-key="${item.k}"><i class="fa-solid fa-trash"></i></button>
                </div>
            </td>
        </tr>`;

        if (isBd) {
            uHTML += `<tr>
                <td style="color:#60a5fa;font-family:monospace;">${item.d.boundDeviceId}</td>
                <td>${item.k}</td>
                <td><button class="action-icon icon-del" data-device="${item.d.boundDeviceId}" data-key="${item.k}"><i class="fa-solid fa-ban"></i> Ban</button></td>
            </tr>`;
        }
    });

    tbody.innerHTML = tHTML;
    usersBody.innerHTML = uHTML === '' ? '<tr><td colspan="3" style="text-align:center;">No active connections</td></tr>' : uHTML;

    document.getElementById('totalKeys').innerText = total;
    document.getElementById('usedKeys').innerText = used;
    attachKeyActions();
}

function attachKeyActions() {
    document.querySelectorAll('.icon-copy').forEach(btn => { btn.removeEventListener('click', copyHandler); btn.addEventListener('click', copyHandler); });
    document.querySelectorAll('.icon-edit').forEach(btn => { btn.removeEventListener('click', editHandler); btn.addEventListener('click', editHandler); });
    document.querySelectorAll('.icon-del').forEach(btn => { btn.removeEventListener('click', deleteHandler); btn.addEventListener('click', deleteHandler); });
    document.querySelectorAll('.icon-reset').forEach(btn => { btn.removeEventListener('click', resetHandler); btn.addEventListener('click', resetHandler); });
    document.querySelectorAll('[data-device]').forEach(btn => { btn.removeEventListener('click', banHandler); btn.addEventListener('click', banHandler); });
}

function copyHandler() {
    const key = this.dataset.key;
    if (key) { navigator.clipboard.writeText(key); showToast("Token Copied!"); }
}

async function editHandler() {
    const key = this.dataset.key;
    if (!key) return;
    const item = globalKeysData.find(d => d.k === key);
    if (!item) return;
    const newHours = prompt(`Update Hours for ${key}:`, item.d.durationHours);
    if (newHours && !isNaN(newHours)) {
        const updates = { durationHours: parseInt(newHours) };
        await update(ref(db, `ActiveUserKeys/${key}`), updates).catch(()=>{});
        for(let fb of globalSecondaryFirebases) { await update(ref(fb.db, `ActiveUserKeys/${key}`), updates).catch(()=>{}); }
        
        await logAdminActivity("Edited Key Time", key, { key: key, oldHours: item.d.durationHours }, "EDIT_KEY");
        showToast("Time Updated Globally!");
    }
}

async function deleteHandler() {
    const key = this.dataset.key;
    if (!key) return;
    if (!confirm(`Delete ${key} from ALL databases?`)) return;
    const item = globalKeysData.find(d => d.k === key);
    if (item) {
        await logAdminActivity("Deleted Key", key, { key: key, data: item.d }, "DELETE_KEY");
    }
    await remove(ref(db, `ActiveUserKeys/${key}`)).catch(()=>{});
    for(let fb of globalSecondaryFirebases) { await remove(ref(fb.db, `ActiveUserKeys/${key}`)).catch(()=>{}); }
    showToast("Key Deleted Globally!");
}

async function resetHandler() {
    const key = this.dataset.key;
    if (!key) return;
    if (!confirm(`Unbind ${key} from current device?`)) return;
    const item = globalKeysData.find(d => d.k === key);
    const updates = { boundDeviceId: "NONE", isUsed: false };
    
    await update(ref(db, `ActiveUserKeys/${key}`), updates).catch(()=>{});
    for(let fb of globalSecondaryFirebases) { await update(ref(fb.db, `ActiveUserKeys/${key}`), updates).catch(()=>{}); }
    
    await logAdminActivity("Unbound Device", key, { key: key, oldDevice: item.d.boundDeviceId }, "RESET_KEY");
    showToast("Device Unbound Globally!");
}

async function banHandler() {
    const deviceId = this.dataset.device;
    const key = this.dataset.key;
    if (!deviceId || !key) return;
    if (!confirm(`Ban ${deviceId} and block access?`)) return;
    
    const item = globalKeysData.find(d => d.k === key);
    await set(ref(db, `BannedDevices/${deviceId}`), { date: serverTimestamp() });
    await remove(ref(db, `ActiveUserKeys/${key}`)).catch(()=>{});
    for(let fb of globalSecondaryFirebases) { await remove(ref(fb.db, `ActiveUserKeys/${key}`)).catch(()=>{}); }
    
    await logAdminActivity("Banned Device", deviceId, { deviceId: deviceId, key: key, keyData: item.d }, "BAN_DEVICE");
    showToast("Device Banned & Key Destroyed!", true);
}

function loadData() {
    if (!db) return;

    onValue(ref(db, 'SystemSettings'), (snap) => {
        const data = snap.exists() ? snap.val() : {};
        if (data.cooldownHours) document.getElementById('settingCooldown').value = data.cooldownHours;
        if (data.maxKeysLimit) document.getElementById('settingMaxKeys').value = data.maxKeysLimit;
        if (data.maintenanceMode !== undefined) document.getElementById('maintModeToggle').checked = data.maintenanceMode;
        
        const adminParam = data.adminParam || 'admin=true';
        const userParam = data.userParam || 'secure=true';
        document.getElementById('settingAdminParam').value = adminParam;
        document.getElementById('settingUserParam').value = userParam;
        
        const baseUrl = window.location.origin + window.location.pathname.replace('admin.html', '');
        document.getElementById('adminLinkPreview').innerText = `${baseUrl}index.html?${adminParam}`;
        document.getElementById('userLinkPreview').innerText = `${baseUrl}?${userParam}`;
        
        if (data.defaultKeyDuration !== undefined) {
            const hours = data.defaultKeyDuration;
            if (hours === 99999) {
                document.getElementById('customTimeVal').value = 1;
                document.getElementById('customTimeType').value = 'hours';
                document.getElementById('lifetimeCheck').checked = true;
                document.getElementById('customTimeVal').disabled = true;
                document.getElementById('customTimeType').disabled = true;
            } else if (hours >= 24 && hours % 24 === 0) {
                document.getElementById('customTimeVal').value = hours / 24;
                document.getElementById('customTimeType').value = 'days';
                document.getElementById('lifetimeCheck').checked = false;
                document.getElementById('customTimeVal').disabled = false;
                document.getElementById('customTimeType').disabled = false;
            } else {
                document.getElementById('customTimeVal').value = hours;
                document.getElementById('customTimeType').value = 'hours';
                document.getElementById('lifetimeCheck').checked = false;
                document.getElementById('customTimeVal').disabled = false;
                document.getElementById('customTimeType').disabled = false;
            }
        }
        if (data.defaultKeyTier) document.getElementById('keyTypeInput').value = data.defaultKeyTier;
    });

    // ==========================================
    // BULLETPROOF ACTIVITY LOG RENDERER
    // ==========================================
    onValue(ref(db, 'AdminLogs'), (snap) => {
        const box = document.getElementById('activityLogBody');
        if (!box) return;
        box.innerHTML = '';
        window.adminLogsCache = {}; 
        
        if (!snap.exists()) {
            box.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;">No recent activity</td></tr>';
            return;
        }
        
        let logs = [];
        snap.forEach(c => logs.push({ id: c.key, data: c.val() }));
        
        let htmlStr = '';
        logs.reverse().slice(0, 25).forEach(item => {
            const log = item.data;
            if (!log) return;
            
            window.adminLogsCache[item.id] = log;
            
            const undoBtn = log.undone ? 
                `<span style="color:#a1a1aa;font-style:italic;">(Undone)</span>` :
                `<button class="action-icon" style="padding:4px 8px;font-size:11px;" onclick="window.executeUndo('${item.id}')"><i class="fa-solid fa-rotate-left"></i> Undo</button>`;
            
            htmlStr += `<tr>
                <td>${log.action || 'System Action'}</td>
                <td style="font-family:monospace;color:#6366f1;">${log.key || '-'}</td>
                <td style="font-size:12px;color:#71717a;">${formatDate(log.time)}</td>
                <td>${undoBtn}</td>
            </tr>`;
        });
        
        box.innerHTML = htmlStr === '' ? '<tr><td colspan="4" style="text-align:center;padding:20px;">No valid activity data</td></tr>' : htmlStr;
    }, (error) => {
        // AGAR FIREBASE ERROR AAYE TOH DIRECT TABLE ME RED COLOR ME DIKHEGA
        const box = document.getElementById('activityLogBody');
        if(box) box.innerHTML = `<tr><td colspan="4" style="color:red; text-align:center;">Firebase Error: ${error.message}</td></tr>`;
    });

    onValue(ref(db, 'SystemStats'), (snap) => {
        const data = snap.exists() ? snap.val() : {};
        document.getElementById('lifetimeKeysCount').innerText = data.totalLifetimeGenerated || 0;
        renderGraph(data.DailyGenerations || {});
    });

    onValue(ref(db, 'ActiveUserKeys'), (snap) => {
        allDbKeys['main'] = snap.exists() ? snap.val() : {};
        renderUnifiedKeys();
    });
}

function loadFirebaseHub() {
    if (!db) return;
    onValue(ref(db, 'ConnectedFirebases'), (snap) => {
        const tbody = document.getElementById('fbTableBody');
        tbody.innerHTML = '';
        const oldIds = Object.keys(activeMirrorListeners);
        const newIds = [];
        globalSecondaryFirebases = [];

        if (snap.exists()) {
            snap.forEach(child => {
                const fbId = child.key;
                const cfg = child.val();
                newIds.push(fbId);
                
                let app, mirrorDb;
                try { app = getApp(fbId); } catch(e) { app = initializeApp(cfg, fbId); }
                mirrorDb = getDatabase(app);
                globalSecondaryFirebases.push({ id: fbId, config: cfg, app: app, db: mirrorDb });

                if (!activeMirrorListeners[fbId]) {
                    activeMirrorListeners[fbId] = onValue(ref(mirrorDb, 'ActiveUserKeys'), (mSnap) => {
                        allDbKeys[fbId] = mSnap.val() || {};
                        renderUnifiedKeys(); 
                    });
                }

                tbody.innerHTML += `<tr>
                    <td style="color:#60a5fa;font-weight:500;">${cfg.projectName}</td>
                    <td style="font-size:12px;color:#a1a1aa;">${cfg.databaseURL}</td>
                    <td><button class="action-icon icon-del" data-fb="${fbId}"><i class="fa-solid fa-trash"></i></button></td>
                </tr>`;
            });
        }

        oldIds.forEach(id => {
            if (!newIds.includes(id)) {
                if (typeof activeMirrorListeners[id] === 'function') activeMirrorListeners[id]();
                delete allDbKeys[id];
                delete activeMirrorListeners[id];
                renderUnifiedKeys();
            }
        });

        document.getElementById('hubCount').innerText = globalSecondaryFirebases.length;

        document.querySelectorAll('[data-fb]').forEach(btn => {
            btn.addEventListener('click', async function() {
                const fbId = this.dataset.fb;
                if (!confirm(`Remove mirror?`)) return;
                try {
                    await remove(ref(db, 'ConnectedFirebases/' + fbId));
                    await logAdminActivity("Removed Mirror DB", fbId, {}, "REMOVE_DB");
                    showToast("Hub Disconnected!", true);
                } catch (e) { showToast(e.message, true); }
            });
        });
    });
}

document.getElementById('addFbBtn')?.addEventListener('click', async function() {
    if (!db) return;
    const btn = this;
    const name = document.getElementById('fbName').value;
    const apiKey = document.getElementById('fbApiKey').value;
    const dbURL = document.getElementById('fbDatabaseURL').value;
    const authDomain = document.getElementById('fbAuthDomain').value;
    const projectId = document.getElementById('fbProjectId').value;
    const appId = document.getElementById('fbAppId').value;
    
    if (!name || !apiKey || !dbURL) return showToast("Fill Name, API Key, DB URL", true);
    
    try {
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        await set(ref(db, 'ConnectedFirebases/FB_' + Date.now()), { 
            projectName: name, apiKey, authDomain, databaseURL: dbURL, projectId, appId 
        });
        await logAdminActivity("Added Mirror DB", name, {}, "ADD_DB");
        document.querySelectorAll('#firebaseHub input, #firebaseHub textarea').forEach(inp => inp.value = '');
        btn.innerHTML = '<i class="fa-solid fa-link"></i> Connect Hub';
        showToast("Hub Connected & Syncing Started!");
    } catch (e) { showToast(e.message, true); btn.innerHTML = '<i class="fa-solid fa-link"></i> Connect Hub'; }
});

document.getElementById('configPaste')?.addEventListener('input', function(e) {
    const val = e.target.value;
    if (!val.trim()) return;
    const extract = (key) => {
        const match = val.match(new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`));
        return match ? match[1] : '';
    };
    document.getElementById('fbApiKey').value = extract('apiKey');
    document.getElementById('fbAuthDomain').value = extract('authDomain');
    document.getElementById('fbDatabaseURL').value = extract('databaseURL');
    document.getElementById('fbProjectId').value = extract('projectId');
    document.getElementById('fbAppId').value = extract('appId');
    showToast("Config Auto-filled!");
});

function randomStr() {
    let r = ''; const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 6; i++) r += c[Math.floor(Math.random() * c.length)]; return r;
}

document.getElementById('generateBtn')?.addEventListener('click', async function() {
    if (!db) return;
    const btn = this;
    const isVip = document.getElementById('keyTypeInput').value === 'vip';
    const note = document.getElementById('keyNote').value;
    
    let dur = 24;
    if (document.getElementById('lifetimeCheck').checked) dur = 99999;
    else {
        const v = parseInt(document.getElementById('customTimeVal').value);
        const t = document.getElementById('customTimeType').value;
        if (!v) return showToast("Invalid Time", true);
        dur = t === 'days' ? v * 24 : v;
    }
    
    const newKey = (isVip ? 'VIP-' : 'PH-') + randomStr();
    const kData = { createdAt: serverTimestamp(), durationHours: dur, isUsed: false, boundDeviceId: "NONE", type: isVip ? "VIP" : "Normal", note: note };

    try {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Syncing Globally...';
        
        await set(ref(db, 'ActiveUserKeys/' + newKey), kData);
        
        await update(ref(db, 'SystemStats'), { totalLifetimeGenerated: increment(1) }).catch(e=>console.log(e));
        const d = new Date();
        const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        await update(ref(db, 'SystemStats/DailyGenerations'), { [ds]: increment(1) }).catch(e=>console.log(e));
        
        await logAdminActivity("Generated Key", newKey, { key: newKey }, "CREATE_KEY");
        
        for (let fb of globalSecondaryFirebases) {
            await set(ref(fb.db, 'ActiveUserKeys/' + newKey), kData).catch(e => console.error("Mirror sync error:", e));
        }
        
        document.getElementById('keyNote').value = '';
        showToast("Token Generated & Pushed to All Hubs!");
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate & Sync';
        window.switchPageInline('manager', document.getElementById('nav-manager'));
    } catch (e) { showToast(e.message, true); btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate & Sync'; }
});

document.getElementById('cleanExpiredBtn')?.addEventListener('click', async function() {
    if (!db) return;
    if (!confirm("Clean expired tokens globally?")) return;
    const now = Date.now();
    let count = 0;
    for (let item of globalKeysData) {
        const cr = item.d.createdAt || now;
        const ex = cr + (item.d.durationHours * 60 * 60 * 1000);
        if (item.d.durationHours !== 99999 && now > ex) {
            remove(ref(db, 'ActiveUserKeys/' + item.k)).catch(()=>{});
            for (let fb of globalSecondaryFirebases) {
                remove(ref(fb.db, 'ActiveUserKeys/' + item.k)).catch(()=>{});
            }
            count++;
        }
    }
    await logAdminActivity("Cleaned Database", `${count} expired keys removed`, {}, "CLEANUP");
    showToast(`Cleaned ${count} expired tokens from all databases!`);
});

document.getElementById('saveRulesBtn')?.addEventListener('click', async function() {
    if (!db) return;
    try {
        // STEP 1: FETCH TRUE PREVIOUS STATE BEFORE SAVING
        const snap = await get(ref(db, 'SystemSettings'));
        const oldDB = snap.exists() ? snap.val() : {};
        
        const oldSettings = {
            cooldownHours: oldDB.cooldownHours !== undefined ? oldDB.cooldownHours : 24,
            maxKeysLimit: oldDB.maxKeysLimit !== undefined ? oldDB.maxKeysLimit : 5
        };
        
        // STEP 2: UPDATE TO NEW VALUE
        const newSettings = {
            cooldownHours: parseInt(document.getElementById('settingCooldown').value),
            maxKeysLimit: parseInt(document.getElementById('settingMaxKeys').value)
        };
        
        await update(ref(db, 'SystemSettings'), newSettings);
        
        // STEP 3: LOG EXACT PREVIOUS STATE
        await logAdminActivity("Updated Limits", `New Limit: ${newSettings.maxKeysLimit} | Cooldown: ${newSettings.cooldownHours}h`, { oldSettings: oldSettings }, "SETTINGS");
        showToast("Rules Saved!");
    } catch (e) { showToast(e.message, true); }
});

document.getElementById('saveLinksBtn')?.addEventListener('click', async function() {
    if (!db) return;
    try {
        // FETCH TRUE PREVIOUS STATE
        const snap = await get(ref(db, 'SystemSettings'));
        const oldDB = snap.exists() ? snap.val() : {};
        
        const oldLinks = {
            userParam: oldDB.userParam !== undefined ? oldDB.userParam : 'secure=true',
            adminParam: oldDB.adminParam !== undefined ? oldDB.adminParam : 'admin=true'
        };
        
        const newLinks = {
            userParam: document.getElementById('settingUserParam').value,
            adminParam: document.getElementById('settingAdminParam').value
        };
        
        await update(ref(db, 'SystemSettings'), newLinks);
        await logAdminActivity("Updated Secret Links", `User: ${newLinks.userParam} | Admin: ${newLinks.adminParam}`, { oldSettings: oldLinks }, "SETTINGS");
        showToast("Links Updated Successfully!");
    } catch (e) { showToast(e.message, true); }
});

document.getElementById('saveGlobalBtn')?.addEventListener('click', async function() {
    if (!db) return;
    try {
        // FETCH TRUE PREVIOUS STATE
        const snap = await get(ref(db, 'SystemSettings'));
        const oldDB = snap.exists() ? snap.val() : {};
        const oldMaint = oldDB.maintenanceMode !== undefined ? oldDB.maintenanceMode : false;
        
        const newMaint = document.getElementById('maintModeToggle').checked;
        
        await update(ref(db, 'SystemSettings'), { maintenanceMode: newMaint });
        await logAdminActivity("App Global Controls", `Maintenance Mode: ${newMaint ? 'ON' : 'OFF'}`, { oldSettings: { maintenanceMode: oldMaint } }, "SETTINGS");
        showToast("Global States Saved!");
    } catch (e) { showToast(e.message, true); }
});

document.getElementById('manualBanBtn')?.addEventListener('click', async function() {
    if (!db) return;
    const deviceId = document.getElementById('banInput').value.trim();
    if (!deviceId) return showToast("Enter Device ID", true);
    try {
        await set(ref(db, 'BannedDevices/' + deviceId), { date: serverTimestamp() });
        await logAdminActivity("Manual Ban", deviceId, {}, "BAN_DEVICE");
        showToast(`Device ${deviceId} banned!`, true);
        document.getElementById('banInput').value = '';
    } catch (e) { showToast(e.message, true); }
});

function startAutoCleanup() {
    if (cleanupInterval) clearInterval(cleanupInterval);
    cleanupInterval = setInterval(async () => {
        if (!db || globalKeysData.length === 0) return;
        const now = Date.now();
        for (let item of globalKeysData) {
            const cr = item.d.createdAt || now;
            const ex = cr + (item.d.durationHours * 60 * 60 * 1000);
            if (item.d.durationHours !== 99999 && now > ex) {
                remove(ref(db, 'ActiveUserKeys/' + item.k)).catch(()=>{});
                for (let fb of globalSecondaryFirebases) {
                    remove(ref(fb.db, 'ActiveUserKeys/' + item.k)).catch(()=>{});
                }
            }
        }
    }, 60000);
}

onAuthStateChanged(auth, (user) => {
    if (user) {
        document.body.setAttribute('data-ready', 'true');
        loadData();
        loadFirebaseHub();
        startAutoCleanup();
        setTimeout(() => { attachAutoSaveListeners(); }, 500);
        setTimeout(() => { if (window.hideStatusOverlay) window.hideStatusOverlay(); }, 1500);
    } else {
        localStorage.removeItem('admin_session');
        window.location.href = 'index.html';
    }
});
