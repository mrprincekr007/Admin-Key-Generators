// admin-script.js - Admin Panel (All Fixes Applied v2.0)
import { auth, db as mainDb } from "./firebase-config.js";
import { initializeApp, getApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { getDatabase, ref, set, onValue, serverTimestamp, remove, update, push, get, child, increment, query, orderByChild, limitToLast } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";

let db = mainDb;
let globalKeysData = [];
let globalSecondaryFirebases = [];
let keysChartInstance = null;
let cleanupInterval = null;
let saveTimeout = null;
let allDbKeys = {}; 
let activeMirrorListeners = {}; 

// ===== PAGINATION =====
let currentPage = 1;
const PAGE_SIZE = 50;
let filteredKeysData = [];
let currentFilter = 'all';

// ===== AUDIT LOG CACHE =====
window.adminLogsCache = {}; 
let allAuditLogs = [];

// ===== NOTIFICATIONS =====
let notifCount = 0;
let notifHistory = [];

// ===== DEBOUNCE =====
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

// ===== TOAST =====
window.showToast = function(msg, isError = false) {
    const toast = document.getElementById('toastNotice');
    if (!toast) return;
    toast.innerText = msg;
    toast.className = '';
    if (isError) toast.classList.add('error');
    toast.classList.add('show');
    setTimeout(() => { toast.classList.remove('show'); }, 4000);
};

// ===== LOGOUT =====
window.logoutAdmin = function() {
    if (confirm('Are you sure you want to logout?')) {
        signOut(auth).then(() => {
            sessionStorage.removeItem('admin_session');
            window.location.href = 'index.html';
        }).catch(() => { window.location.href = 'index.html'; });
    }
};

// ===== DATE FORMATTER =====
function formatDate(ts) {
    if (!ts || typeof ts === 'object') return "Just Now"; 
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "Just Now";
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// ===== NOTIFICATIONS =====
function addNotification(text) {
    notifCount++;
    notifHistory.unshift({ text, time: new Date() });
    if (notifHistory.length > 20) notifHistory.pop();
    const badge = document.getElementById('notifBadge');
    const dropdown = document.getElementById('notifDropdown');
    if (badge) {
        badge.style.display = 'flex';
        badge.textContent = notifCount > 99 ? '99+' : notifCount;
    }
    if (dropdown) {
        dropdown.innerHTML = notifHistory.map(n => 
            `<div class="notification-item">${n.text}<div class="notif-time">${formatDate(n.time)}</div></div>`
        ).join('');
    }
}

// ===== ACTIVITY LOG =====
async function logAdminActivity(action, key, undoDataObj, type) {
    if (!db) return;
    try {
        await push(ref(db, 'AdminLogs'), {
            action, key, type,
            undoData: JSON.stringify(undoDataObj || {}),
            time: serverTimestamp(),
            undone: false
        });
    } catch (e) { console.error("Log error:", e); }
}

// ===== UNDO ENGINE =====
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
        } else if (type === 'CREATE_KEY') {
            await remove(ref(db, 'ActiveUserKeys/' + undoData.key));
            globalSecondaryFirebases.forEach(fb => remove(ref(fb.db, 'ActiveUserKeys/' + undoData.key)).catch(()=>{}));
            showToast("Key Generation Undone!");
        } else if (type === 'EDIT_KEY') {
            const updates = { durationHours: undoData.oldHours };
            await update(ref(db, 'ActiveUserKeys/' + undoData.key), updates);
            globalSecondaryFirebases.forEach(fb => update(ref(fb.db, 'ActiveUserKeys/' + undoData.key), updates).catch(()=>{}));
            showToast("Key Time Reverted Globally!");
        } else if (type === 'RESET_KEY') {
            const updates = { boundDeviceId: undoData.oldDevice, isUsed: true };
            await update(ref(db, 'ActiveUserKeys/' + undoData.key), updates);
            globalSecondaryFirebases.forEach(fb => update(ref(fb.db, 'ActiveUserKeys/' + undoData.key), updates).catch(()=>{}));
            showToast("Device Re-bound Globally!");
        } else if (type === 'BAN_DEVICE') {
            await remove(ref(db, 'BannedDevices/' + undoData.deviceId));
            if (undoData.keyData) {
                await set(ref(db, 'ActiveUserKeys/' + undoData.key), undoData.keyData);
                globalSecondaryFirebases.forEach(fb => set(ref(fb.db, 'ActiveUserKeys/' + undoData.key), undoData.keyData).catch(()=>{}));
            }
            showToast("Device Unbanned & Key Restored!");
        } else if (type === 'SETTINGS') {
            if(undoData.oldSettings) {
                await update(ref(db, 'SystemSettings'), undoData.oldSettings);
                showToast("Settings Reverted to previous state!");
            }
        }
        
        await update(ref(db, 'AdminLogs/' + logId), { undone: true });
        await logAdminActivity("Used Undo Action", `Reverted ${type}`, {}, "UNDO");
    } catch (e) { 
        showToast("Error: " + e.message, true); 
    }
};

window.clearActivityLog = async function() {
    if (!db) return;
    if (confirm("Clear all history?")) {
        try { await remove(ref(db, 'AdminLogs')); showToast("History Cleared!"); } 
        catch (e) { showToast(e.message, true); }
    }
};

// ===== AUDIT LOG FILTERING =====
window.filterAuditLogs = function() {
    renderAuditLogs(allAuditLogs);
};

function renderAuditLogs(logs) {
    const box = document.getElementById('activityLogBody');
    if (!box) return;
    
    let filtered = [...logs];
    const typeFilter = document.getElementById('auditTypeFilter')?.value;
    const dateFrom = document.getElementById('auditDateFrom')?.value;
    const dateTo = document.getElementById('auditDateTo')?.value;
    
    if (typeFilter && typeFilter !== 'all') {
        filtered = filtered.filter(l => l.data?.type === typeFilter);
    }
    if (dateFrom) {
        const from = new Date(dateFrom).getTime();
        filtered = filtered.filter(l => (l.data?.time || 0) >= from);
    }
    if (dateTo) {
        const to = new Date(dateTo).setHours(23,59,59,999);
        filtered = filtered.filter(l => (l.data?.time || 0) <= to);
    }
    
    let htmlStr = '';
    filtered.reverse().slice(0, 50).forEach(item => {
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
    
    box.innerHTML = htmlStr || '<tr><td colspan="4" style="text-align:center;padding:20px;">No matching activity</td></tr>';
}

// ===== CHART =====
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
            labels, datasets: [{
                label: 'Keys Generated', data: counts,
                borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.2)',
                borderWidth: 2, fill: true, tension: 0.4, pointRadius: 2
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#a1a1aa' }, grid: { display: false } },
                y: { ticks: { color: '#a1a1aa', stepSize: 1 }, grid: { color: '#27272a' }, beginAtZero: true }
            }
        }
    });
}

// ===== AUTO-SAVE DEFAULTS =====
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
            const snap = await get(ref(db, 'SystemSettings'));
            const oldDB = snap.exists() ? snap.val() : {};
            const oldSet = {
                defaultKeyDuration: oldDB.defaultKeyDuration ?? 24,
                defaultKeyTier: oldDB.defaultKeyTier ?? 'normal',
                defaultKeyLifetime: oldDB.defaultKeyLifetime ?? false
            };
            await update(ref(db, 'SystemSettings'), { defaultKeyDuration: duration, defaultKeyTier: tier, defaultKeyLifetime: lifetime });
            await logAdminActivity("Auto-Saved Settings", `New Default - Tier: ${tier}, Duration: ${duration}h`, { oldSettings: oldSet }, "SETTINGS");
            document.getElementById('saveDefaultDurationBtn').innerHTML = 'Saved!';
            setTimeout(() => { document.getElementById('saveDefaultDurationBtn').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save as Default'; }, 1500);
        } catch (e) { console.error("Auto-save error:", e); }
    }, 500);
}

function attachAutoSaveListeners() {
    ['customTimeVal', 'customTimeType', 'keyTypeInput', 'lifetimeCheck'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.removeEventListener('change', autoSaveDefaultSettings);
            el.addEventListener('change', autoSaveDefaultSettings);
        }
    });
}

// ===== KEY MANAGER (with Pagination + Bulk Selection) =====
let selectedKeys = new Set();

window.toggleSelectAll = function() {
    const checked = document.getElementById('selectAll').checked;
    const startIdx = (currentPage - 1) * PAGE_SIZE;
    const pageItems = filteredKeysData.slice(startIdx, startIdx + PAGE_SIZE);
    pageItems.forEach(item => {
        if (checked) selectedKeys.add(item.k);
        else selectedKeys.delete(item.k);
    });
    updateBulkUI();
    renderUnifiedKeys();
};

window.clearSelection = function() {
    selectedKeys.clear();
    document.getElementById('selectAll').checked = false;
    updateBulkUI();
    renderUnifiedKeys();
};

function updateBulkUI() {
    const bulkEl = document.getElementById('bulkActions');
    const countEl = document.getElementById('bulkCount');
    if (selectedKeys.size > 0) {
        bulkEl.classList.add('show');
        countEl.textContent = `${selectedKeys.size} selected`;
    } else {
        bulkEl.classList.remove('show');
    }
}

window.bulkDelete = async function() {
    if (selectedKeys.size === 0) return;
    if (!confirm(`Delete ${selectedKeys.size} keys from ALL databases?`)) return;
    for (const key of selectedKeys) {
        const item = globalKeysData.find(d => d.k === key);
        if (item) await logAdminActivity("Deleted Key", key, { key, data: item.d }, "DELETE_KEY");
        await remove(ref(db, 'ActiveUserKeys/' + key)).catch(()=>{});
        globalSecondaryFirebases.forEach(fb => remove(ref(fb.db, 'ActiveUserKeys/' + key)).catch(()=>{}));
    }
    showToast(`${selectedKeys.size} keys deleted globally!`);
    addNotification(`${selectedKeys.size} keys bulk deleted`);
    selectedKeys.clear();
    updateBulkUI();
};

window.bulkUnbind = async function() {
    if (selectedKeys.size === 0) return;
    if (!confirm(`Unbind ${selectedKeys.size} keys from devices?`)) return;
    for (const key of selectedKeys) {
        const item = globalKeysData.find(d => d.k === key);
        const updates = { boundDeviceId: "NONE", isUsed: false };
        await update(ref(db, 'ActiveUserKeys/' + key), updates).catch(()=>{});
        globalSecondaryFirebases.forEach(fb => update(ref(fb.db, 'ActiveUserKeys/' + key), updates).catch(()=>{}));
        if (item) await logAdminActivity("Unbound Device", key, { key, oldDevice: item.d.boundDeviceId }, "RESET_KEY");
    }
    showToast(`${selectedKeys.size} keys unbound!`);
    selectedKeys.clear();
    updateBulkUI();
};

const debouncedRenderKeys = debounce(() => renderUnifiedKeys(), 300);

function renderUnifiedKeys() {
    const tbody = document.getElementById('tableBody');
    const usersBody = document.getElementById('usersBody');
    let total = 0, used = 0;
    
    let mergedKeys = {};
    for (let source in allDbKeys) {
        for (let k in allDbKeys[source]) {
            if (!mergedKeys[k]) mergedKeys[k] = { ...allDbKeys[source][k] };
            else if (allDbKeys[source][k].boundDeviceId && allDbKeys[source][k].boundDeviceId !== "NONE") {
                mergedKeys[k].boundDeviceId = allDbKeys[source][k].boundDeviceId;
                mergedKeys[k].isUsed = allDbKeys[source][k].isUsed;
            }
        }
    }

    globalKeysData = [];
    for (let k in mergedKeys) globalKeysData.push({ k, d: mergedKeys[k] });
    globalKeysData.sort((a, b) => (b.d.createdAt || 0) - (a.d.createdAt || 0));

    // Apply search + type filter
    const searchTerm = (document.getElementById('searchInput')?.value || '').toLowerCase();
    const now = Date.now();
    filteredKeysData = globalKeysData.filter(item => {
        if (searchTerm && !item.k.toLowerCase().includes(searchTerm) && !(item.d.note || '').toLowerCase().includes(searchTerm)) return false;
        if (currentFilter !== 'all') {
            const cr = item.d.createdAt || now;
            const ex = cr + (item.d.durationHours * 60 * 60 * 1000);
            const isEx = item.d.durationHours !== 99999 && now > ex;
            const isBd = item.d.boundDeviceId && item.d.boundDeviceId !== "NONE";
            if (currentFilter === 'vip' && !item.k.includes('VIP')) return false;
            if (currentFilter === 'normal' && item.k.includes('VIP')) return false;
            if (currentFilter === 'active' && !isBd) return false;
            if (currentFilter === 'expired' && !isEx) return false;
        }
        return true;
    });

    if (filteredKeysData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:30px;">Empty Database</td></tr>';
        usersBody.innerHTML = '<tr><td colspan="3" style="text-align:center;">No active connections</td></tr>';
        document.getElementById('totalKeys').innerText = globalKeysData.length;
        document.getElementById('usedKeys').innerText = 0;
        document.getElementById('pagination').innerHTML = '';
        return;
    }

    const totalPages = Math.ceil(filteredKeysData.length / PAGE_SIZE);
    if (currentPage > totalPages) currentPage = totalPages;
    const startIdx = (currentPage - 1) * PAGE_SIZE;
    const pageItems = filteredKeysData.slice(startIdx, startIdx + PAGE_SIZE);

    let tHTML = '', uHTML = '';
    pageItems.forEach(item => {
        total++;
        const now = Date.now();
        const cr = item.d.createdAt || now;
        const ex = cr + (item.d.durationHours * 60 * 60 * 1000);
        const isEx = item.d.durationHours !== 99999 && now > ex;
        const isBd = item.d.boundDeviceId && item.d.boundDeviceId !== "NONE";
        if (isBd) used++;
        const isChecked = selectedKeys.has(item.k) ? 'checked' : '';

        const badge = item.k.includes('VIP') ? `<span class="badge badge-vip">VIP</span>` : `<span class="badge badge-normal">NORM</span>`;
        const note = item.d.note ? `<div style="color:#a1a1aa;font-size:11px;margin-top:5px;"><i class="fa-solid fa-tag"></i> ${item.d.note}</div>` : '';

        tHTML += `<tr>
            <td><input type="checkbox" ${isChecked} onchange="if(this.checked)window._selectKey('${item.k}');else window._deselectKey('${item.k}')"></td>
            <td><div class="key-code">${item.k}</div>${badge} ${isEx ? '<span class="badge" style="background:#ef4444;color:#fff;">EXP</span>' : ''}${note}</td>
            <td>
                <div style="color:#e4e4e7;font-size:13px;"><i class="fa-solid fa-clock" style="color:#a1a1aa;"></i> ${item.d.durationHours === 99999 ? 'Lifetime' : item.d.durationHours + 'h'}</div>
                <div style="color:#71717a;font-size:11px;">Cr: ${formatDate(cr)}</div>
                <div style="color:#71717a;font-size:11px;">Ex: ${item.d.durationHours === 99999 ? 'Never' : formatDate(ex)}</div>
            </td>
            <td><div style="color:${isBd ? '#34d399' : '#71717a'};font-family:monospace;font-size:12px;">${isBd ? item.d.boundDeviceId : 'Unlinked'}</div></td>
            <td>
                <div style="display:flex;gap:5px;flex-wrap:wrap;">
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
    usersBody.innerHTML = uHTML || '<tr><td colspan="3" style="text-align:center;">No active connections</td></tr>';
    document.getElementById('totalKeys').innerText = globalKeysData.length;
    document.getElementById('usedKeys').innerText = used;
    
    renderPagination(totalPages);
    attachKeyActions();
    updateBulkUI();
}

window._selectKey = function(k) { selectedKeys.add(k); updateBulkUI(); };
window._deselectKey = function(k) { selectedKeys.delete(k); updateBulkUI(); };

// ===== KEY TYPE FILTER (from inline HTML) =====
window.applyKeyFilter = function(type) {
    currentFilter = type;
    currentPage = 1;
    selectedKeys.clear();
    renderUnifiedKeys();
};

function renderPagination(totalPages) {
    const pag = document.getElementById('pagination');
    if (!pag || totalPages <= 1) { if (pag) pag.innerHTML = ''; return; }
    let html = `<button ${currentPage===1?'disabled':''} onclick="window.goToPage(${currentPage-1})"><i class="fa-solid fa-chevron-left"></i></button>`;
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 2) {
            html += `<button class="${i===currentPage?'active':''}" onclick="window.goToPage(${i})">${i}</button>`;
        } else if (Math.abs(i - currentPage) === 3) {
            html += `<button disabled>...</button>`;
        }
    }
    html += `<button ${currentPage===totalPages?'disabled':''} onclick="window.goToPage(${currentPage+1})"><i class="fa-solid fa-chevron-right"></i></button>`;
    html += `<span style="font-size:12px;color:#a1a1aa;margin-left:10px;">${filteredKeysData.length} keys</span>`;
    pag.innerHTML = html;
}

window.goToPage = function(page) {
    currentPage = page;
    renderUnifiedKeys();
};

// ===== SEARCH (with debounce + persistence) =====
document.getElementById('searchInput')?.addEventListener('input', debounce(function() {
    currentPage = 1;
    selectedKeys.clear();
    renderUnifiedKeys();
    sessionStorage.setItem('admin_search', this.value);
}, 300));

// Restore search
const savedSearch = sessionStorage.getItem('admin_search');
if (savedSearch) {
    document.getElementById('searchInput').value = savedSearch;
}

// ===== KEY ACTIONS =====
function attachKeyActions() {
    document.querySelectorAll('.icon-copy').forEach(btn => { btn.onclick = function() { navigator.clipboard.writeText(this.dataset.key); showToast("Token Copied!"); }; });
    document.querySelectorAll('.icon-edit').forEach(btn => { btn.onclick = editHandler; });
    document.querySelectorAll('.icon-del').forEach(btn => { btn.onclick = this.dataset.device ? banHandler : deleteHandler; });
    document.querySelectorAll('.icon-reset').forEach(btn => { btn.onclick = resetHandler; });
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
        globalSecondaryFirebases.forEach(fb => update(ref(fb.db, `ActiveUserKeys/${key}`), updates).catch(()=>{}));
        await logAdminActivity("Edited Key Time", key, { key, oldHours: item.d.durationHours }, "EDIT_KEY");
        showToast("Time Updated Globally!");
        addNotification(`Key ${key} time edited`);
    }
}

async function deleteHandler() {
    const key = this.dataset.key;
    if (!key || !confirm(`Delete ${key} from ALL databases?`)) return;
    const item = globalKeysData.find(d => d.k === key);
    if (item) await logAdminActivity("Deleted Key", key, { key, data: item.d }, "DELETE_KEY");
    await remove(ref(db, `ActiveUserKeys/${key}`)).catch(()=>{});
    globalSecondaryFirebases.forEach(fb => remove(ref(fb.db, `ActiveUserKeys/${key}`)).catch(()=>{}));
    showToast("Key Deleted Globally!");
    addNotification(`Key ${key} deleted`);
}

async function resetHandler() {
    const key = this.dataset.key;
    if (!key || !confirm(`Unbind ${key} from current device?`)) return;
    const item = globalKeysData.find(d => d.k === key);
    const updates = { boundDeviceId: "NONE", isUsed: false };
    await update(ref(db, `ActiveUserKeys/${key}`), updates).catch(()=>{});
    globalSecondaryFirebases.forEach(fb => update(ref(fb.db, `ActiveUserKeys/${key}`), updates).catch(()=>{}));
    await logAdminActivity("Unbound Device", key, { key, oldDevice: item?.d.boundDeviceId }, "RESET_KEY");
    showToast("Device Unbound Globally!");
}

async function banHandler() {
    const deviceId = this.dataset.device;
    const key = this.dataset.key;
    if (!deviceId || !key || !confirm(`Ban ${deviceId} and block access?`)) return;
    const item = globalKeysData.find(d => d.k === key);
    await set(ref(db, `BannedDevices/${deviceId}`), { date: serverTimestamp() });
    await remove(ref(db, `ActiveUserKeys/${key}`)).catch(()=>{});
    globalSecondaryFirebases.forEach(fb => remove(ref(fb.db, `ActiveUserKeys/${key}`)).catch(()=>{}));
    await logAdminActivity("Banned Device", deviceId, { deviceId, key, keyData: item?.d }, "BAN_DEVICE");
    showToast("Device Banned & Key Destroyed!", true);
    addNotification(`Device ${deviceId} banned`);
}

// ===== LOAD DATA =====
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
        
        const adminBase = window.location.origin + window.location.pathname.replace(/admin\.html.*$/, '');
        const userBase = adminBase.replace(/Admin-Key-Generators\/Admin-Key-Generators-main\/?$/, 'Key-Generators/Key-Generators-main/');
        document.getElementById('adminLinkPreview').innerText = `${adminBase}index.html?${adminParam}`;
        document.getElementById('userLinkPreview').innerText = `${userBase}?${userParam}`;
        
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

    // Activity Log with filtering
    onValue(ref(db, 'AdminLogs'), (snap) => {
        allAuditLogs = [];
        if (snap.exists()) {
            snap.forEach(c => allAuditLogs.push({ id: c.key, data: c.val() }));
        }
        renderAuditLogs(allAuditLogs);
    }, (error) => {
        const box = document.getElementById('activityLogBody');
        if(box) box.innerHTML = `<tr><td colspan="4" style="color:red;text-align:center;">Firebase Error: ${error.message}</td></tr>`;
    });

    onValue(ref(db, 'SystemStats'), (snap) => {
        const data = snap.exists() ? snap.val() : {};
        document.getElementById('lifetimeKeysCount').innerText = data.totalLifetimeGenerated || 0;
        renderGraph(data.DailyGenerations || {});
    });

    onValue(ref(db, 'ActiveUserKeys'), (snap) => {
        allDbKeys['main'] = snap.exists() ? snap.val() : {};
        debouncedRenderKeys();
    });
}

// ===== FIREBASE HUB =====
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
                        debouncedRenderKeys(); 
                    });
                }

                tbody.innerHTML += `<tr>
                    <td style="color:#60a5fa;font-weight:500;">${cfg.projectName}</td>
                    <td style="font-size:12px;color:#a1a1aa;">${cfg.databaseURL}</td>
                    <td><button class="action-icon icon-del" data-fb="${fbId}"><i class="fa-solid fa-trash"></i></button></td>
                </tr>`;
            });
        }

        // Cleanup removed listeners
        oldIds.forEach(id => {
            if (!newIds.includes(id)) {
                if (typeof activeMirrorListeners[id] === 'function') activeMirrorListeners[id]();
                delete allDbKeys[id];
                delete activeMirrorListeners[id];
                debouncedRenderKeys();
            }
        });

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

// ===== CONFIG VALIDATION =====
function validateFirebaseConfig(cfg) {
    const errors = [];
    if (!cfg.apiKey || cfg.apiKey.length < 10) errors.push("Invalid API Key");
    if (!cfg.databaseURL || !cfg.databaseURL.includes('firebaseio.com')) errors.push("Invalid Database URL");
    if (!cfg.projectId) errors.push("Missing Project ID");
    return errors;
}

document.getElementById('addFbBtn')?.addEventListener('click', async function() {
    if (!db) return;
    const btn = this;
    const name = document.getElementById('fbName').value.trim();
    const apiKey = document.getElementById('fbApiKey').value.trim();
    const dbURL = document.getElementById('fbDatabaseURL').value.trim();
    const authDomain = document.getElementById('fbAuthDomain').value.trim();
    const projectId = document.getElementById('fbProjectId').value.trim();
    const appId = document.getElementById('fbAppId').value.trim();
    
    if (!name || !apiKey || !dbURL) return showToast("Fill Name, API Key, DB URL", true);
    
    const errors = validateFirebaseConfig({ apiKey, databaseURL: dbURL, projectId });
    const errorDiv = document.getElementById('configError');
    if (errors.length > 0) {
        if (errorDiv) { errorDiv.textContent = errors.join(', '); errorDiv.style.display = 'block'; }
        return;
    }
    if (errorDiv) errorDiv.style.display = 'none';
    
    try {
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        await set(ref(db, 'ConnectedFirebases/FB_' + Date.now()), { 
            projectName: name, apiKey, authDomain, databaseURL: dbURL, projectId, appId 
        });
        await logAdminActivity("Added Mirror DB", name, {}, "ADD_DB");
        document.querySelectorAll('#firebaseHub input, #firebaseHub textarea').forEach(inp => inp.value = '');
        btn.innerHTML = '<i class="fa-solid fa-link"></i> Connect Hub';
        showToast("Hub Connected & Syncing Started!");
        addNotification(`Mirror DB "${name}" connected`);
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

// ===== KEY GENERATION =====
function randomStr() {
    let r = ''; const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 6; i++) r += c[Math.floor(Math.random() * c.length)]; return r;
}

document.getElementById('generateBtn')?.addEventListener('click', async function() {
    if (!db) return;
    const btn = this;
    const isVip = document.getElementById('keyTypeInput').value === 'vip';
    const note = document.getElementById('keyNote').value.trim();
    
    let dur = 24;
    if (document.getElementById('lifetimeCheck').checked) dur = 99999;
    else {
        const v = parseInt(document.getElementById('customTimeVal').value);
        const t = document.getElementById('customTimeType').value;
        if (!v || v <= 0) return showToast("Invalid Time", true);
        dur = t === 'days' ? v * 24 : v;
    }
    
    const newKey = (isVip ? 'VIP-' : 'PH-') + randomStr();
    const kData = { createdAt: serverTimestamp(), durationHours: dur, isUsed: false, boundDeviceId: "NONE", type: isVip ? "VIP" : "Normal", note: note || undefined };

    try {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Syncing...';
        
        // Write to mirrors first, then main (consistency)
        for (let fb of globalSecondaryFirebases) {
            await set(ref(fb.db, 'ActiveUserKeys/' + newKey), kData).catch(e => console.error("Mirror sync:", e));
        }
        await set(ref(db, 'ActiveUserKeys/' + newKey), kData);
        
        await update(ref(db, 'SystemStats'), { totalLifetimeGenerated: increment(1) }).catch(()=>{});
        const d = new Date();
        const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        await update(ref(db, 'SystemStats/DailyGenerations'), { [ds]: increment(1) }).catch(()=>{});
        
        await logAdminActivity("Generated Key", newKey, { key: newKey }, "CREATE_KEY");
        
        document.getElementById('keyNote').value = '';
        showToast("Token Generated & Pushed to All Hubs!");
        addNotification(`New ${isVip?'VIP':'Normal'} key created: ${newKey}`);
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate & Sync';
        window.switchPageInline('manager', document.getElementById('nav-manager'));
    } catch (e) { showToast(e.message, true); btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate & Sync'; }
});

// ===== CLEAN EXPIRED =====
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
            globalSecondaryFirebases.forEach(fb => remove(ref(fb.db, 'ActiveUserKeys/' + item.k)).catch(()=>{}));
            count++;
        }
    }
    await logAdminActivity("Cleaned Database", `${count} expired keys removed`, {}, "CLEANUP");
    showToast(`Cleaned ${count} expired tokens!`);
    addNotification(`${count} expired keys cleaned`);
});

// ===== EXPORT CSV =====
document.getElementById('exportCsvBtn')?.addEventListener('click', function() {
    if (filteredKeysData.length === 0) return showToast("No data to export", true);
    let csv = 'Key,Type,Duration(h),Created,Expires,Device,Bound,Note\n';
    filteredKeysData.forEach(item => {
        const cr = item.d.createdAt ? new Date(item.d.createdAt).toISOString() : '';
        const ex = item.d.durationHours === 99999 ? 'Never' : (item.d.createdAt ? new Date(item.d.createdAt + item.d.durationHours*3600000).toISOString() : '');
        csv += `"${item.k}","${item.d.type||''}",${item.d.durationHours},"${cr}","${ex}","${item.d.boundDeviceId||''}","${item.d.isUsed}","${item.d.note||''}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `keys_export_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    showToast(`Exported ${filteredKeysData.length} keys!`);
});

// ===== RULES SAVE =====
document.getElementById('saveRulesBtn')?.addEventListener('click', async function() {
    if (!db) return;
    try {
        const snap = await get(ref(db, 'SystemSettings'));
        const oldDB = snap.exists() ? snap.val() : {};
        const oldSettings = { cooldownHours: oldDB.cooldownHours ?? 24, maxKeysLimit: oldDB.maxKeysLimit ?? 5 };
        const newSettings = {
            cooldownHours: parseInt(document.getElementById('settingCooldown').value) || 24,
            maxKeysLimit: parseInt(document.getElementById('settingMaxKeys').value) || 5
        };
        await update(ref(db, 'SystemSettings'), newSettings);
        await logAdminActivity("Updated Limits", `New Limit: ${newSettings.maxKeysLimit} | Cooldown: ${newSettings.cooldownHours}h`, { oldSettings }, "SETTINGS");
        showToast("Rules Saved!");
        addNotification("User limits updated");
    } catch (e) { showToast(e.message, true); }
});

// ===== LINKS SAVE =====
document.getElementById('saveLinksBtn')?.addEventListener('click', async function() {
    if (!db) return;
    try {
        const snap = await get(ref(db, 'SystemSettings'));
        const oldDB = snap.exists() ? snap.val() : {};
        const oldLinks = { userParam: oldDB.userParam ?? 'secure=true', adminParam: oldDB.adminParam ?? 'admin=true' };
        const newLinks = {
            userParam: document.getElementById('settingUserParam').value.trim() || 'secure=true',
            adminParam: document.getElementById('settingAdminParam').value.trim() || 'admin=true'
        };
        await update(ref(db, 'SystemSettings'), newLinks);
        await logAdminActivity("Updated Secret Links", `User: ${newLinks.userParam} | Admin: ${newLinks.adminParam}`, { oldSettings: oldLinks }, "SETTINGS");
        showToast("Links Updated Successfully!");
    } catch (e) { showToast(e.message, true); }
});

// ===== GLOBAL CONTROLS =====
document.getElementById('saveGlobalBtn')?.addEventListener('click', async function() {
    if (!db) return;
    try {
        const snap = await get(ref(db, 'SystemSettings'));
        const oldDB = snap.exists() ? snap.val() : {};
        const updates = {
            maintenanceMode: document.getElementById('maintModeToggle').checked
        };
        await update(ref(db, 'SystemSettings'), updates);
        await logAdminActivity("App Global Controls", `Maintenance: ${updates.maintenanceMode ? 'ON' : 'OFF'}`, { oldSettings: { maintenanceMode: oldDB.maintenanceMode ?? false } }, "SETTINGS");
        showToast("Global States Saved!");
        addNotification(`Maintenance mode ${updates.maintenanceMode ? 'ON' : 'OFF'}`);
    } catch (e) { showToast(e.message, true); }
});

// ===== MANUAL BAN =====
document.getElementById('manualBanBtn')?.addEventListener('click', async function() {
    if (!db) return;
    const deviceId = document.getElementById('banInput').value.trim();
    if (!deviceId) return showToast("Enter Device ID", true);
    try {
        await set(ref(db, 'BannedDevices/' + deviceId), { date: serverTimestamp() });
        await logAdminActivity("Manual Ban", deviceId, {}, "BAN_DEVICE");
        showToast(`Device ${deviceId} banned!`, true);
        addNotification(`Device ${deviceId} manually banned`);
        document.getElementById('banInput').value = '';
    } catch (e) { showToast(e.message, true); }
});

// ===== AUTO CLEANUP (with toggle) =====
function startAutoCleanup() {
    if (cleanupInterval) clearInterval(cleanupInterval);
    cleanupInterval = setInterval(async () => {
        const autoCleanupEnabled = document.getElementById('autoCleanupToggle')?.checked;
        if (!db || !autoCleanupEnabled || globalKeysData.length === 0) return;
        const now = Date.now();
        for (let item of globalKeysData) {
            const cr = item.d.createdAt || now;
            const ex = cr + (item.d.durationHours * 60 * 60 * 1000);
            if (item.d.durationHours !== 99999 && now > ex) {
                remove(ref(db, 'ActiveUserKeys/' + item.k)).catch(()=>{});
                globalSecondaryFirebases.forEach(fb => remove(ref(fb.db, 'ActiveUserKeys/' + item.k)).catch(()=>{}));
            }
        }
    }, 60000);
}

// ===== DASHBOARD REFRESH =====
window.refreshDashboard = function() {
    showToast("Dashboard refreshed!");
    loadData();
};

// ===== INIT =====
onAuthStateChanged(auth, (user) => {
    if (user) {
        document.body.setAttribute('data-ready', 'true');
        loadData();
        loadFirebaseHub();
        startAutoCleanup();
        setTimeout(() => { attachAutoSaveListeners(); }, 500);
        setTimeout(() => { window.hideStatusOverlay?.(); }, 1500);
    } else {
        sessionStorage.removeItem('admin_session');
        window.location.href = 'index.html';
    }
});
