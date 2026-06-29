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

    function registerPush(reg) {
        reg.pushManager.getSubscription().then(function (existing) {
            if (existing) {
                // Re-send existing subscription so server has the current counselorId linked
                fetch('/api/push-subscribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ subscription: existing.toJSON() })
                }).catch(function () {});
                return;
            }
            if (Notification.permission === 'denied') return;

            var doSubscribe = function () {
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
                    .catch(function () {});
            };

            if (Notification.permission === 'granted') {
                doSubscribe();
            } else {
                Notification.requestPermission().then(function (p) {
                    if (p === 'granted') doSubscribe();
                });
            }
        }).catch(function () {});
    }

    if ('serviceWorker' in navigator && 'PushManager' in window) {
        navigator.serviceWorker.register('/sw.js').then(registerPush).catch(function () {});
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
