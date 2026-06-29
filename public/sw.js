self.addEventListener('push', function (e) {
    const data = e.data ? e.data.json() : {};
    e.waitUntil(
        self.registration.showNotification(data.title || 'Camp Hub', {
            body:      data.body || '',
            tag:       'att-nudge',
            renotify:  true,
            data:      { url: data.url || '/staff' }
        })
    );
});

self.addEventListener('notificationclick', function (e) {
    e.notification.close();
    const url = (e.notification.data && e.notification.data.url) || '/staff';
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
            for (var i = 0; i < list.length; i++) {
                if ('focus' in list[i]) return list[i].focus();
            }
            if (clients.openWindow) return clients.openWindow(url);
        })
    );
});
