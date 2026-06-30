// Attendance nudge banner + push notification setup — staff view only
(function () {
    function getCookie(name) {
        return document.cookie.split('; ').reduce(function (acc, pair) {
            var parts = pair.split('=');
            return parts[0] === name ? decodeURIComponent(parts[1] || '') : acc;
        }, null);
    }

    if (getCookie('viewMode') !== 'staff') return;

    // ── Push notification subscription ──────────────────────────────────────
    function urlBase64ToUint8Array(b64) {
        var padding = '='.repeat((4 - b64.length % 4) % 4);
        var base64  = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
        var raw     = atob(base64);
        var arr     = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        return arr;
    }

    var swReg = null;

    // Called directly from a button tap — satisfies iOS Safari's user-gesture requirement.
    window.enablePushNotifications = function () {
        if (!swReg) return;
        if (Notification.permission === 'denied') {
            alert('Notifications are blocked. Please enable them in your device settings, then try again.');
            return;
        }
        Notification.requestPermission().then(function (p) {
            if (p !== 'granted') return;
            doSubscribe(swReg);
        });
    };

    function doSubscribe(reg) {
        fetch('/api/vapid-public-key')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                return reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(data.publicKey)
                });
            })
            .then(function (sub) {
                return fetch('/api/push-subscribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ subscription: sub.toJSON() })
                });
            })
            .then(function () { updateNotifyButton(); })
            .catch(function () {});
    }

    function updateNotifyButton() {
        var enableBtn  = document.getElementById('enableNotifyBtn');
        var disableBtn = document.getElementById('disableNotifyBtn');
        var supported  = ('Notification' in window) && ('PushManager' in window);

        function setEnable(subscribed) {
            if (enableBtn) {
                if (!supported) { enableBtn.style.display = 'none'; return; }
                if (Notification.permission === 'denied') {
                    enableBtn.textContent = '🔔 Notifications blocked — check settings';
                    enableBtn.disabled = true;
                    enableBtn.style.display = '';
                } else {
                    enableBtn.disabled = false;
                    enableBtn.style.display = subscribed ? 'none' : '';
                }
            }
            if (disableBtn) {
                disableBtn.style.display = (supported && subscribed) ? '' : 'none';
            }
        }

        if (!supported) { setEnable(false); return; }
        if (swReg) {
            swReg.pushManager.getSubscription().then(function (sub) { setEnable(!!sub); });
        } else {
            setEnable(false);
        }
    }

    window.disablePushNotifications = function () {
        if (!swReg) return;
        swReg.pushManager.getSubscription().then(function (sub) {
            if (!sub) { updateNotifyButton(); return; }
            sub.unsubscribe().then(function () {
                fetch('/api/push-unsubscribe', { method: 'POST' }).catch(function () {});
                updateNotifyButton();
            }).catch(function () {});
        });
    };

    if ('serviceWorker' in navigator && 'PushManager' in window) {
        navigator.serviceWorker.register('/sw.js').then(function (reg) {
            swReg = reg;
            reg.pushManager.getSubscription().then(function (existing) {
                if (existing) {
                    // Re-link existing subscription to the current counselorId
                    fetch('/api/push-subscribe', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ subscription: existing.toJSON() })
                    }).catch(function () {});
                }
                updateNotifyButton();
            }).catch(function () {});
        }).catch(function () {});
    }
    // ────────────────────────────────────────────────────────────────────────

    var banner = null;

    function ensureBanner() {
        if (banner) return;
        banner = document.createElement('div');
        banner.id = 'att-nudge-banner';
        banner.style.cssText = 'position:sticky;top:0;z-index:9999;background:#dc2626;color:#fff;' +
            'text-align:center;padding:10px 16px;font-size:0.95rem;font-weight:600;display:none;';
        document.body.insertBefore(banner, document.body.firstChild);
    }

    function poll() {
        fetch('/api/attendance-nudge')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                ensureBanner();
                if (data.notify && data.classes && data.classes.length > 0) {
                    banner.textContent = '⚠️ Please submit attendance for: ' + data.classes.join(', ');
                    banner.style.display = 'block';
                } else {
                    banner.style.display = 'none';
                }
            })
            .catch(function () {});
    }

    // Run immediately on load, then every 60 seconds
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', poll);
    } else {
        poll();
    }
    setInterval(poll, 60 * 1000);

    // ── Staff alert banner ───────────────────────────────────────────────────
    var alertBanner = null;
    var SK_ALERT = 'staffAlertDismissed';

    function ensureAlertBanner() {
        if (alertBanner) return;
        alertBanner = document.createElement('div');
        alertBanner.id = 'staff-alert-banner';
        alertBanner.style.cssText = 'position:sticky;top:0;z-index:9998;background:#b91c1c;color:#fff;' +
            'display:none;align-items:center;justify-content:space-between;gap:12px;' +
            'padding:10px 20px;font-size:0.9rem;font-weight:600;';
        var msgSpan = document.createElement('span');
        msgSpan.id = 'staff-alert-msg';
        var dismissBtn = document.createElement('button');
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.style.cssText = 'background:rgba(255,255,255,0.25);border:none;color:white;' +
            'border-radius:6px;padding:3px 12px;cursor:pointer;font-weight:700;font-size:0.85rem;white-space:nowrap;';
        dismissBtn.onclick = function () {
            localStorage.setItem(SK_ALERT, String(alertBanner._alertId || 0));
            alertBanner.style.display = 'none';
        };
        alertBanner.appendChild(msgSpan);
        alertBanner.appendChild(dismissBtn);
        document.body.insertBefore(alertBanner, document.body.firstChild);
    }

    function showAlertBanner(alert) {
        var dismissed = parseInt(localStorage.getItem(SK_ALERT) || '0');
        if (alert.AlertID <= dismissed) return;
        ensureAlertBanner();
        document.getElementById('staff-alert-msg').textContent =
            alert.message + (alert.sentBy ? ' — ' + alert.sentBy : '');
        alertBanner.style.display = 'flex';
        alertBanner._alertId = alert.AlertID;
    }

    function pollAlert() {
        fetch('/api/staff-alert-banner')
            .then(function (r) { return r.json(); })
            .then(function (data) { if (data.alert) showAlertBanner(data.alert); })
            .catch(function () {});
    }

    pollAlert();
    setInterval(pollAlert, 30000);
    // ────────────────────────────────────────────────────────────────────────
})();

document.addEventListener('DOMContentLoaded', function () {
    const nav = document.querySelector('.nav-bar');
    if (!nav) return;

    const btn = document.createElement('button');
    btn.className = 'nav-toggle';
    btn.setAttribute('aria-label', 'Toggle navigation');
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = '☰';

    btn.addEventListener('click', function () {
        const isOpen = nav.classList.toggle('nav-open');
        btn.textContent = isOpen ? '✕' : '☰';
        btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    // Insert toggle as first child of nav
    nav.insertBefore(btn, nav.firstChild);

    // Close menu when any nav link is clicked
    nav.querySelectorAll('.nav-btn').forEach(function (link) {
        link.addEventListener('click', function () {
            nav.classList.remove('nav-open');
            btn.textContent = '☰';
            btn.setAttribute('aria-expanded', 'false');
        });
    });
});
