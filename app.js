import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
env.allowLocalModels = false;
env.useBrowserCache = true;
const MODEL = 'onnx-community/SmolLM2-135M-Instruct-ONNX-MHA';
const $ = id => document.getElementById(id);
const labels = ['', 'Sweet', 'Flirty', 'Bold', 'Extra Sassy'];
const personalities = ['', 'Warm and affectionate.', 'Playful and flirty.', 'Witty and teasing.', 'Sassy and mischievous.'];
const PIN_KEY = 'vault-pin-v1';
let generator = null, busy = false, chat = [], unlocked = false, booted = false;
const encoder = new TextEncoder();
const toHex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
async function pinHash(pin, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits({name:'PBKDF2', salt:encoder.encode(salt), iterations:210000, hash:'SHA-256'}, key, 256));
}
function lockVault() {
  unlocked = false;
  $('appmain').hidden = true;
  $('lockscreen').hidden = false;
  $('pin').value = '';
  const hasPin = !!localStorage.getItem(PIN_KEY);
  $('lockhint').textContent = hasPin ? 'Enter your PIN to unlock Vault.' : 'Create a 6–12 digit PIN to protect casual access.';
  $('pinbutton').textContent = hasPin ? 'Unlock' : 'Set PIN';
}
const status = s => { $('status').textContent = s; };
// Keep the existing database name and schema so saved chats/media remain available.
const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open('spicy-ai-local', 2);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', {keyPath:'id'});
    if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function dbOperation(store, mode, action) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode), req = action(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}
const put = (store, value, key) => dbOperation(store, 'readwrite', s => key === undefined ? s.put(value) : s.put(value, key));
const get = (store, key) => dbOperation(store, 'readonly', s => s.get(key));
const all = store => dbOperation(store, 'readonly', s => s.getAll());
async function bubble(m) {
  const el = document.createElement('div');
  el.className = 'bubble ' + (m.role === 'user' ? 'user' : '');
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = m.role === 'user' ? 'You' : 'Vault AI';
  el.append(who);
  if (m.text) { const t = document.createElement('div'); t.textContent = m.text; el.append(t); }
  if (m.mediaId) {
    try {
      const blob = await get('media', m.mediaId);
      if (blob) {
        const media = document.createElement(m.mediaType?.startsWith('video/') ? 'video' : 'img');
        media.src = URL.createObjectURL(blob);
        if (media.tagName === 'VIDEO') { media.controls = true; media.playsInline = true; }
        else { media.alt = 'Attached photo'; media.loading = 'lazy'; }
        el.append(media);
      }
    } catch (err) { console.warn('Media restore failed', err); }
  }
  $('messages').append(el);
  $('messages').scrollTop = $('messages').scrollHeight;
}
async function save(role, text = '', mediaId = null, mediaType = null) {
  const m = {id:crypto.randomUUID(), role, text, mediaId, mediaType, time:Date.now()};
  chat.push(m);
  await put('messages', m);
  await bubble(m);
  return m;
}
async function boot() {
  if (booted) return;
  chat = (await all('messages')).sort((a, b) => a.time - b.time);
  $('messages').replaceChildren();
  for (const m of chat) await bubble(m);
  booted = true;
  status(generator ? 'Ready — local AI' : 'Ready to load offline AI');
}
$('pinform').onsubmit = async e => {
  e.preventDefault();
  const pin = $('pin').value;
  $('lockerror').textContent = '';
  if (!/^\d{6,12}$/.test(pin)) { $('lockerror').textContent = 'Use 6–12 digits.'; return; }
  $('pinbutton').disabled = true;
  try {
    const saved = JSON.parse(localStorage.getItem(PIN_KEY) || 'null');
    if (saved) { if (await pinHash(pin, saved.salt) !== saved.hash) throw Error('Incorrect PIN'); }
    else {
      const salt = crypto.randomUUID();
      localStorage.setItem(PIN_KEY, JSON.stringify({salt, hash:await pinHash(pin, salt)}));
    }
    unlocked = true;
    $('lockscreen').hidden = true;
    $('appmain').hidden = false;
    $('pin').value = '';
    await boot();
  } catch (err) { $('lockerror').textContent = err.message || 'Unlock failed'; }
  finally { $('pinbutton').disabled = false; }
};
$('lock').onclick = lockVault;
lockVault();
document.addEventListener('visibilitychange', () => { if (document.hidden && unlocked) lockVault(); });
$('spice').oninput = () => {
  $('level').textContent = labels[+$('spice').value] || 'Flirty';
  localStorage.setItem('spicy-level', $('spice').value);
};
$('spice').value = localStorage.getItem('spicy-level') || '2';
$('spice').oninput();
$('reset').onclick = async () => {
  if (!unlocked || busy || !confirm('Permanently erase all chat messages and saved photos/videos?')) return;
  const db = await dbPromise;
  await Promise.all(['messages','media'].map(name => new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    tx.objectStore(name).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  })));
  chat = [];
  $('messages').replaceChildren();
  status(generator ? 'Ready — local AI' : 'Chat cleared');
};
$('load').onclick = async () => {
  if (!unlocked || busy || generator) return;
  busy = true;
  $('load').disabled = true;
  try {
    status('Loading local AI…');
    generator = await pipeline('text-generation', MODEL, {
      device:'wasm', dtype:'q4',
      progress_callback:p => {
        if (p.status === 'progress') status(`Model: ${Math.round(p.progress || 0)}% ${p.file || ''}`);
        else if (p.status === 'ready') status('Preparing AI…');
      }
    });
    status('AI loaded. Ready to chat.');
    $('load').textContent = 'AI loaded ✓';
  } catch (err) { console.error(err); status('Could not load AI: ' + (err.message || err)); }
  finally { busy = false; $('load').disabled = false; }
};
// Do not feed long repetitive old replies back into the small model.
function recentConversation() {
  return chat.filter(m => m.text && (m.role === 'user' || m.role === 'assistant'))
    .filter(m => !m.text.startsWith('Tap “Download') && !m.text.startsWith('Generation error:'))
    .filter(m => m.role === 'user' || (m.text.length < 200 && !/(.{20,}?)\1/i.test(m.text)))
    .slice(-4)
    .map(m => ({role:m.role, content:m.text.slice(0, 160)}));
}
function cleanReply(raw) {
  const parts = String(raw || '').trim().match(/[^.!?]+[.!?]?/g) || [];
  const seen = new Set(), output = [];
  for (const part of parts) {
    const sentence = part.trim();
    if (!sentence || seen.has(sentence.toLowerCase())) continue;
    seen.add(sentence.toLowerCase());
    output.push(sentence);
    if (output.length === 2) break;
  }
  return output.join(' ').slice(0, 200) || 'Tell me more 😉';
}
$('composer').onsubmit = async e => {
  e.preventDefault();
  if (!unlocked || busy) return;
  const text = $('prompt').value.trim();
  if (!text) return;
  $('prompt').value = '';
  await save('user', text);
  if (!generator) { await save('assistant', 'Tap “Download / load offline AI” first.'); return; }
  busy = true;
  $('send').disabled = true;
  status('Thinking on your iPhone…');
  try {
    const messages = [
      {role:'system', content:`You are Vault, a fictional adult female AI companion. ${personalities[+$('spice').value] || personalities[2]} Answer the user's latest message directly. One short natural text reply. No repeated phrases.`},
      ...recentConversation()
    ];
    const result = await generator(messages, {
      max_new_tokens:32, do_sample:true, temperature:0.8,
      top_p:0.9, repetition_penalty:1.25, no_repeat_ngram_size:3
    });
    const generated = result?.[0]?.generated_text;
    const raw = Array.isArray(generated) ? generated.at(-1)?.content : String(generated || '').slice(-500);
    await save('assistant', cleanReply(raw));
    status('Ready — local AI');
  } catch (err) {
    console.error(err);
    await save('assistant', 'Generation error: ' + (err.message || err));
    status('Generation failed');
  } finally { busy = false; $('send').disabled = false; }
};
$('media').onchange = async e => {
  if (!unlocked) return;
  for (const file of [...e.target.files]) {
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) continue;
    if (file.size > 80 * 1024 * 1024) {
      await save('assistant', `“${file.name}” exceeds the 80 MB limit.`); continue;
    }
    try {
      const id = crypto.randomUUID();
      await put('media', file, id);
      await save('user', file.name, id, file.type);
      await save('assistant', 'Saved locally. This text AI cannot interpret images or videos.');
    } catch (err) { await save('assistant', 'Could not save media: ' + (err.message || err)); }
  }
  e.target.value = '';
};
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);
