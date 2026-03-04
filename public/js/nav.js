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
