'use strict';
// the "someone is using this PC" bar: who, and a button to end it right away
const text = document.getElementById('text');
text.textContent = new URLSearchParams(location.search).get('text') || 'remote display on';
window.bar.onText(t => { text.textContent = t; });
document.getElementById('stop').onclick = () => window.bar.stop();
