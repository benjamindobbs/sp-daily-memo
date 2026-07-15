// Shared camper autocomplete (nurse-style) with color-group pills.
//
// Usage:
//   initCamperAC({
//       input:    'camperSearchAC',      // id or element of the text input
//       dropdown: 'acDropdown',          // id or element of the dropdown container
//       hidden:   'camperIdHidden',      // optional: id or element of hidden CamperID input
//       campers:  [{ id, label, color }],
//       maxResults: 30,                  // optional
//       onSelect: function(camper) {}    // optional callback after selection
//   });
//
// Markup convention (same as nurse):
//   <div class="camper-autocomplete">
//       <input type="text" id="..." autocomplete="off">
//       <input type="hidden" id="...">
//       <div class="ac-dropdown" id="..."></div>
//   </div>
function initCamperAC(opts) {
    const el = ref => (typeof ref === 'string' ? document.getElementById(ref) : ref);
    const input    = el(opts.input);
    const dropdown = el(opts.dropdown);
    const hidden   = opts.hidden ? el(opts.hidden) : null;
    const max      = opts.maxResults || 30;
    let activeIdx  = -1;
    let matches    = [];

    function render(term) {
        const q = term.trim().toLowerCase();
        dropdown.innerHTML = '';
        activeIdx = -1;
        if (!q) { dropdown.style.display = 'none'; return; }
        matches = opts.campers.filter(c => c.label.toLowerCase().includes(q)).slice(0, max);
        if (!matches.length) {
            dropdown.innerHTML = '<div class="ac-empty">No campers found</div>';
        } else {
            matches.forEach(c => {
                const div = document.createElement('div');
                div.className = 'ac-option';
                div.dataset.id = c.id;
                if (c.color) {
                    const pill = document.createElement('span');
                    pill.className = 'ac-color ' + c.color;
                    pill.textContent = c.color;
                    div.appendChild(pill);
                }
                div.appendChild(document.createTextNode(c.label));
                div.addEventListener('mousedown', e => { e.preventDefault(); choose(c); });
                dropdown.appendChild(div);
            });
        }
        dropdown.style.display = 'block';
    }

    function choose(c) {
        input.value = c.label;
        if (hidden) hidden.value = c.id;
        dropdown.style.display = 'none';
        if (opts.onSelect) opts.onSelect(c);
    }

    input.addEventListener('input', () => {
        if (hidden) hidden.value = '';
        render(input.value);
    });

    input.addEventListener('keydown', e => {
        const options = dropdown.querySelectorAll('.ac-option');
        if (!options.length) return;
        if (e.key === 'ArrowDown') {
            activeIdx = Math.min(activeIdx + 1, options.length - 1);
        } else if (e.key === 'ArrowUp') {
            activeIdx = Math.max(activeIdx - 1, -1);
        } else if (e.key === 'Enter') {
            if (activeIdx >= 0 && matches[activeIdx]) {
                e.preventDefault();
                choose(matches[activeIdx]);
            }
            return;
        } else if (e.key === 'Escape') {
            dropdown.style.display = 'none';
            return;
        } else {
            return;
        }
        options.forEach((o, i) => o.classList.toggle('active', i === activeIdx));
    });

    document.addEventListener('click', e => {
        const wrap = input.closest('.camper-autocomplete');
        if (wrap && !wrap.contains(e.target)) dropdown.style.display = 'none';
    });
}
