// A small local web page with the same numbers as `omnitrix list`, refreshed every few seconds.
import http from 'node:http';
import { Engine } from './engine.js';
import { refreshQuotas } from './quota.js';
import type { Job } from './types.js';
import { VERSION } from './version.js';

function recentJobs(engine: Engine, limit = 30): Partial<Job>[] {
  return engine.listJobs(limit).map((j) => ({
    id: j.id,
    status: j.status,
    accountId: j.accountId,
    model: j.model,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    verdict: j.verdict,
    error: j.error?.slice(0, 200),
    usage: j.usage,
    task: { title: j.task.title, type: j.task.type } as Job['task'],
  }));
}

export function startDashboard(port: number): string {
  const engine = new Engine();
  const server = http.createServer((req, res) => {
    // only answer requests made to this machine by name (blocks DNS-rebinding tricks)
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') {
      res.writeHead(403).end('forbidden');
      return;
    }
    // Any website can make the browser call this server, and each status call starts a quota read.
    // Browsers label such calls; only our own page, a typed address or a tool that sends no label gets in.
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (req.url === '/api/status') {
      void refreshQuotas(engine.config().accounts);
      const body = JSON.stringify({ version: VERSION, now: Date.now(), accounts: engine.pool(), jobs: recentJobs(engine) });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body);
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" }).end(PAGE);
      return;
    }
    res.writeHead(404).end('not found');
  });
  server.listen(port, '127.0.0.1');
  return `http://127.0.0.1:${port}`;
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>omnitrix</title>
<style>
:root{--bg:#f5f8fc;--card:#fff;--ink:#14233d;--mute:#5d7190;--line:#d6dfec;--ok:#17945b;--warn:#c98a06;--bad:#c2413a;--bar:#1677c9;--barbg:#e6eef8}
@media (prefers-color-scheme:dark){:root{--bg:#101a2e;--card:#16233d;--ink:#e7eef8;--mute:#8ea3c2;--line:#2b3c5e;--ok:#5ad19a;--warn:#f4b740;--bad:#f2665a;--bar:#4cc9f0;--barbg:#22345a}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;align-items:baseline;gap:12px;padding:20px 24px 8px}h1{font-size:20px;margin:0}header small{color:var(--mute)}
main{padding:8px 24px 32px;max-width:1200px}
.sum{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 18px}.sum div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:120px}
.sum b{display:block;font-size:22px}.sum span{color:var(--mute);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.acc{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.acc h3{margin:0 0 2px;font-size:15px;display:flex;justify-content:space-between;gap:8px}.meta{color:var(--mute);font-size:12px;margin-bottom:8px}
.pill{font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid currentColor;white-space:nowrap}
.ready{color:var(--ok)}.busy{color:var(--bar)}.cooling,.exhausted,.offline{color:var(--warn)}.auth_error,.disabled{color:var(--bad)}
.win{margin:6px 0}.win .lbl{display:flex;justify-content:space-between;font-size:12px;color:var(--mute)}
.bar{height:6px;background:var(--barbg);border-radius:4px;overflow:hidden}.bar i{display:block;height:100%;background:var(--bar)}
.bar i.hi{background:var(--warn)}.bar i.full{background:var(--bad)}
.kv{font-size:12px;color:var(--mute)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:8px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}th{color:var(--mute);font-weight:500}
h2{font-size:15px;margin:26px 0 4px}.err{color:var(--bad);font-size:12px}
@media (max-width:600px){header,main{padding-left:16px;padding-right:16px}td:nth-child(4),th:nth-child(4){display:none}}
</style>
</head>
<body>
<header><h1>omnitrix</h1><small id="ver"></small><small id="when"></small></header>
<main>
<div class="sum" id="sum"></div>
<div class="grid" id="accounts"></div>
<h2>Recent jobs</h2>
<table><thead><tr><th>Task</th><th>Status</th><th>Account / model</th><th>Tokens</th><th>When</th></tr></thead><tbody id="jobs"></tbody></table>
</main>
<script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n);
const ago=t=>{const s=Math.round((Date.now()-t)/1000);return s<60?s+'s ago':s<3600?Math.round(s/60)+'m ago':Math.round(s/3600)+'h ago'};
const at=t=>new Date(t).toLocaleString([],{weekday:'short',hour:'numeric',minute:'2-digit'});
const left=t=>{const m=Math.max(0,Math.round((t-Date.now())/60000));return m<60?m+' min':m<1440?Math.floor(m/60)+' h '+(m%60)+' min':Math.floor(m/1440)+' d '+Math.floor(m%1440/60)+' h'};
async function load(){
  let d;try{d=await (await fetch('/api/status',{cache:'no-store'})).json()}catch(e){document.getElementById('when').textContent='offline';return}
  document.getElementById('ver').textContent='v'+d.version;
  document.getElementById('when').textContent='updated '+new Date(d.now).toLocaleTimeString();
  const acc=d.accounts, ready=acc.filter(a=>a.state==='ready'||a.state==='busy').length;
  const req=acc.reduce((s,a)=>s+a.usage.requestsToday,0), tok=acc.reduce((s,a)=>s+a.usage.tokensToday,0), cost=acc.reduce((s,a)=>s+a.usage.costToday,0);
  document.getElementById('sum').innerHTML=[[ready+'/'+acc.length,'accounts ready'],[req,'requests today'],[fmt(tok),'tokens today'],['$'+cost.toFixed(2),'known cost today']].map(([b,s])=>'<div><b>'+esc(b)+'</b><span>'+esc(s)+'</span></div>').join('');
  document.getElementById('accounts').innerHTML=acc.length?acc.map(a=>{
    const u=a.usage;
    const wins=u.windows.map(w=>{const p=Math.min(100,Math.round(w.used/w.limit*100));const pct=w.unit==='percent';return '<div class="win"><div class="lbl"><span>'+esc(w.name)+(pct?'':' ('+esc(w.unit)+')')+'</span><span>'+(pct?Math.round(w.remaining)+'% left':fmt(w.remaining)+' of '+fmt(w.limit)+' left')+'</span></div><div class="bar"><i class="'+(p>=100?'full':p>=80?'hi':'')+'" style="width:'+p+'%"></i></div>'+(w.resetsAt?'<div class="kv">resets in '+esc(left(w.resetsAt))+', at '+esc(at(w.resetsAt))+'</div>':'')+'</div>'}).join('');
    const meas=u.measured&&u.measured.remainingRequests!==undefined?'<div class="kv">provider says '+u.measured.remainingRequests+' requests left</div>':'';
    return '<div class="acc"><h3><span>'+esc(a.label)+'</span><span class="pill '+esc(a.state)+'">'+esc(a.state.replace('_',' '))+'</span></h3>'
      +'<div class="meta">'+esc(a.id)+(a.id!==a.provider?' ('+esc(a.provider)+')':'')+', owned by '+esc(a.owner)+(u.plan?', '+esc(u.plan)+' plan':'')+(a.local?', runs on this PC':'')+'</div>'
      +(wins||'<div class="kv">No limits set for this account.</div>')+meas
      +'<div class="kv">Today '+u.requestsToday+' requests and '+fmt(u.tokensToday)+' tokens'+(u.costToday?', $'+u.costToday.toFixed(3):'')+'. Numbers are '+esc(u.source==='measured'?'from the provider':u.source==='estimated'?'counted by omnitrix':'not tracked')+'.</div>'
      +(a.reason?'<div class="err">'+esc(a.reason)+'</div>':'')
      +(a.pausedModels&&a.pausedModels.length?'<div class="kv">Resting after errors: '+esc(a.pausedModels.join(', '))+'</div>':'')
      +'<div class="kv">'+esc(a.models.slice(0,5).join(', '))+(a.models.length>5?' +'+(a.models.length-5):'')+'</div></div>'}).join(''):'<p>No accounts yet. Run <code>omnitrix add</code>.</p>';
  document.getElementById('jobs').innerHTML=d.jobs.length?d.jobs.map(j=>'<tr><td>'+esc(j.task.title)+'<div class="kv">'+esc(j.task.type)+'</div>'+(j.error&&j.status!=='done'?'<div class="err">'+esc(j.error)+'</div>':'')+'</td><td><span class="pill '+(j.status==='done'?'ready':j.status==='failed'?'auth_error':'busy')+'">'+esc(j.status)+'</span>'+(j.verdict?'<div class="kv">'+esc(j.verdict)+'</div>':'')+'</td><td>'+esc((j.accountId||'-')+' / '+(j.model||'-'))+'</td><td>'+(j.usage?fmt(j.usage.inputTokens+j.usage.outputTokens):'')+'</td><td>'+ago(j.createdAt)+'</td></tr>').join(''):'<tr><td colspan="5" class="kv">No jobs yet.</td></tr>';
}
load();setInterval(load,4000);
</script>
</body>
</html>`;
