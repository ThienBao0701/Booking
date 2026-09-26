/**
 * Minimal single-page UI for the mock Extranet. Server-rendered static HTML +
 * vanilla JS talking to /api. Elements carry stable ids and data-view/data-action
 * attributes so the BrowserController / replay engine can target them reliably
 * (docs/04-replay-format.md).
 */

export function renderApp(): string {
  return `<!doctype html>
<html lang="en" data-app="mock-extranet">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mock Extranet</title>
<style>
  :root{--bg:#0f1220;--panel:#171b2e;--ink:#e7e9f3;--muted:#9aa3c0;--accent:#6ea8fe;--ok:#5cd6a0;--warn:#f0b357;--line:#2a3050}
  @media (prefers-color-scheme: light){:root{--bg:#f5f6fb;--panel:#fff;--ink:#1a1c2b;--muted:#5b6486;--line:#e2e5f0}}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
  header{display:flex;align-items:center;gap:16px;padding:12px 16px;border-bottom:1px solid var(--line)}
  header h1{font-size:16px;margin:0}
  .badge{font-size:12px;color:var(--muted)}
  nav{display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px;border-bottom:1px solid var(--line)}
  nav button{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 10px;cursor:pointer}
  nav button.active{border-color:var(--accent);color:var(--accent)}
  main{display:grid;grid-template-columns:1fr 340px;gap:16px;padding:16px}
  @media (max-width:820px){main{grid-template-columns:1fr}}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
  .view{display:none}
  .view.active{display:block}
  label{display:block;font-size:12px;color:var(--muted);margin:8px 0 4px}
  input,select,textarea{width:100%;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px}
  .btn{margin-top:12px;background:var(--accent);color:#0b1020;border:0;border-radius:8px;padding:9px 14px;font-weight:600;cursor:pointer}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
  #feed{max-height:70vh;overflow:auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
  .ev{padding:4px 0;border-bottom:1px dashed var(--line)}
  .wf{color:var(--accent)}
  .note{font-size:12px;color:var(--muted);margin-top:8px}
</style>
</head>
<body>
<header>
  <h1>Mock Extranet</h1>
  <span class="badge">local simulation · emits workflow events · safe replay target</span>
  <span class="badge" id="actor" data-actor="">not logged in</span>
</header>
<nav id="nav">
  <button data-view="login" class="active">Login</button>
  <button data-view="property">Property</button>
  <button data-view="rooms">Rooms</button>
  <button data-view="rates">Rates</button>
  <button data-view="reservations">Reservations</button>
  <button data-view="messages">Messages</button>
  <button data-view="reviews">Reviews</button>
  <button data-view="photos">Photos</button>
  <button data-view="reports">Reports</button>
</nav>
<main>
  <section class="panel">
    <div class="view active" data-view="login">
      <h3>Login</h3>
      <label for="login-username">Username</label>
      <input id="login-username" name="username" autocomplete="username" placeholder="operator" />
      <p class="note">This mock accepts a username only. No password is requested or stored.</p>
      <button class="btn" id="login-submit" data-action="login">Log in</button>
    </div>

    <div class="view" data-view="property">
      <h3>Property setup</h3>
      <label for="prop-name">Name</label>
      <input id="prop-name" name="name" placeholder="Seaside Villa" />
      <label for="prop-address">Address</label>
      <input id="prop-address" name="address" placeholder="1 Ocean Rd" />
      <button class="btn" id="prop-submit" data-action="createProperty">Create property</button>
      <table id="prop-table"><thead><tr><th>Name</th><th>Status</th><th>ID</th></tr></thead><tbody></tbody></table>
    </div>

    <div class="view" data-view="rooms">
      <h3>Room setup</h3>
      <label for="room-property">Property</label>
      <select id="room-property" name="propertyId"></select>
      <div class="row">
        <div><label for="room-name">Room name</label><input id="room-name" name="name" placeholder="Deluxe King" /></div>
        <div><label for="room-type">Type</label><input id="room-type" name="roomType" placeholder="double" /></div>
      </div>
      <label for="room-capacity">Capacity</label>
      <input id="room-capacity" name="capacity" type="number" value="2" />
      <button class="btn" id="room-submit" data-action="createRoom">Add room</button>
      <table id="room-table"><thead><tr><th>Name</th><th>Type</th><th>Cap</th></tr></thead><tbody></tbody></table>
    </div>

    <div class="view" data-view="rates">
      <h3>Rate setup</h3>
      <label for="rate-room">Room</label>
      <select id="rate-room" name="roomId"></select>
      <div class="row">
        <div><label for="rate-label">Label</label><input id="rate-label" name="label" value="standard" /></div>
        <div><label for="rate-amount">Amount</label><input id="rate-amount" name="amount" type="number" value="120" /></div>
      </div>
      <button class="btn" id="rate-submit" data-action="setRate">Save rate</button>
    </div>

    <div class="view" data-view="reservations">
      <h3>Reservations</h3>
      <label for="res-property">Property</label>
      <select id="res-property" name="propertyId"></select>
      <label for="res-room">Room</label>
      <select id="res-room" name="roomId"></select>
      <label for="res-guest">Guest name (test data)</label>
      <input id="res-guest" name="guestName" placeholder="Test Guest" />
      <div class="row">
        <div><label for="res-in">Check-in</label><input id="res-in" name="checkIn" type="date" /></div>
        <div><label for="res-out">Check-out</label><input id="res-out" name="checkOut" type="date" /></div>
      </div>
      <button class="btn" id="res-submit" data-action="createReservation">Create reservation</button>
      <table id="res-table"><thead><tr><th>Guest</th><th>Status</th><th></th></tr></thead><tbody></tbody></table>
    </div>

    <div class="view" data-view="messages">
      <h3>Messaging</h3>
      <label for="msg-text">Message (test data)</label>
      <textarea id="msg-text" name="text" rows="3" placeholder="Hello, your booking is confirmed."></textarea>
      <button class="btn" id="msg-submit" data-action="sendMessage">Send</button>
    </div>

    <div class="view" data-view="reviews">
      <h3>Reviews</h3>
      <label for="rev-property">Property</label>
      <select id="rev-property" name="propertyId"></select>
      <label for="rev-rating">Rating (1-5)</label>
      <input id="rev-rating" name="rating" type="number" min="1" max="5" value="5" />
      <label for="rev-text">Text (test data)</label>
      <textarea id="rev-text" name="text" rows="2"></textarea>
      <button class="btn" id="rev-submit" data-action="addReview">Add review</button>
    </div>

    <div class="view" data-view="photos">
      <h3>Photos</h3>
      <label for="photo-property">Property</label>
      <select id="photo-property" name="propertyId"></select>
      <label for="photo-name">Filename (metadata only)</label>
      <input id="photo-name" name="filename" value="room.jpg" />
      <button class="btn" id="photo-submit" data-action="uploadPhoto">Upload (metadata)</button>
      <p class="note">No file bytes are uploaded; only filename + size metadata are recorded.</p>
    </div>

    <div class="view" data-view="reports">
      <h3>Reporting</h3>
      <label for="report-property">Property</label>
      <select id="report-property" name="propertyId"></select>
      <button class="btn" id="report-submit" data-action="generateReport">Generate report</button>
      <pre id="report-out" data-report=""></pre>
    </div>
  </section>

  <aside class="panel">
    <h3>Workflow event feed</h3>
    <div id="feed" data-feed=""></div>
  </aside>
</main>
<script>
${clientScript()}
</script>
</body>
</html>`;
}

function clientScript(): string {
  // Kept as a plain string so no bundler is required.
  return `
const $ = (s) => document.querySelector(s);
const api = async (method, path, body) => {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};
const num = (v) => Number(v || 0);

document.querySelectorAll('#nav button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#nav button').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    b.classList.add('active');
    const v = document.querySelector('.view[data-view="' + b.dataset.view + '"]');
    if (v) v.classList.add('active');
    refresh();
  });
});

async function refresh() {
  try {
    const [props, rooms, res] = await Promise.all([
      api('GET', '/properties'), api('GET', '/rooms'), api('GET', '/reservations'),
    ]);
    fillSelect(['#room-property','#res-property','#rev-property','#photo-property','#report-property'], props.properties, (p)=>p.name);
    fillSelect(['#rate-room','#res-room'], rooms.rooms, (r)=>r.name);
    fillTable('#prop-table', props.properties, (p)=>['<td>'+esc(p.name)+'</td><td>'+p.status+'</td><td>'+p.id.slice(0,8)+'</td>']);
    fillTable('#room-table', rooms.rooms, (r)=>['<td>'+esc(r.name)+'</td><td>'+esc(r.roomType)+'</td><td>'+r.capacity+'</td>']);
    fillTable('#res-table', res.reservations, (r)=>['<td>'+esc(r.guestName)+'</td><td>'+r.status+'</td><td><button data-cancel="'+r.id+'">cancel</button></td>']);
    document.querySelectorAll('[data-cancel]').forEach((btn)=>btn.addEventListener('click', async()=>{await api('POST','/reservations/'+btn.dataset.cancel+'/cancel');refresh();feed();}));
  } catch (e) { /* not logged in yet */ }
}
function esc(s){return String(s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function fillSelect(sels, items, label){sels.forEach((sel)=>{const el=$(sel);if(!el)return;el.innerHTML=items.map((i)=>'<option value="'+i.id+'">'+esc(label(i))+'</option>').join('');});}
function fillTable(sel, items, cols){const el=document.querySelector(sel+' tbody');if(!el)return;el.innerHTML=items.map((i)=>'<tr>'+cols(i).join('')+'</tr>').join('');}

async function feed() {
  try {
    const { events } = await api('GET', '/events');
    $('#feed').innerHTML = events.slice(-100).reverse().map((e)=>{
      const t = new Date(e.ts).toISOString().slice(11,19);
      return '<div class="ev">'+t+' <span class="wf">'+e.workflow+'</span> '+e.module+'.'+e.action+'</div>';
    }).join('');
  } catch (e) {}
}

const actions = {
  login: async()=>{const u=$('#login-username').value;const r=await api('POST','/login',{username:u});$('#actor').textContent='logged in: '+u;$('#actor').dataset.actor=u;},
  createProperty: async()=>{await api('POST','/properties',{name:$('#prop-name').value,address:$('#prop-address').value});},
  createRoom: async()=>{await api('POST','/rooms',{propertyId:$('#room-property').value,name:$('#room-name').value,roomType:$('#room-type').value,capacity:num($('#room-capacity').value)});},
  setRate: async()=>{await api('POST','/rates',{roomId:$('#rate-room').value,label:$('#rate-label').value,amount:num($('#rate-amount').value)});},
  createReservation: async()=>{await api('POST','/reservations',{propertyId:$('#res-property').value,roomId:$('#res-room').value,guestName:$('#res-guest').value,checkIn:$('#res-in').value,checkOut:$('#res-out').value});},
  sendMessage: async()=>{await api('POST','/messages',{reservationId:null,text:$('#msg-text').value});},
  addReview: async()=>{await api('POST','/reviews',{propertyId:$('#rev-property').value,rating:num($('#rev-rating').value),text:$('#rev-text').value});},
  uploadPhoto: async()=>{await api('POST','/photos',{propertyId:$('#photo-property').value,filename:$('#photo-name').value,sizeBytes:12345});},
  generateReport: async()=>{const r=await api('POST','/reports',{propertyId:$('#report-property').value});const out=$('#report-out');out.textContent=JSON.stringify(r,null,2);out.dataset.report='1';},
};
document.querySelectorAll('[data-action]').forEach((btn)=>{
  btn.addEventListener('click', async()=>{
    try{ await actions[btn.dataset.action](); await refresh(); await feed(); }
    catch(e){ alert(e.message); }
  });
});
setInterval(feed, 2000);
feed();
`;
}
