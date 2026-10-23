/**
 * 金价监听站 · Cloudflare Worker
 *
 * 部署步骤（纯网页）：
 * 1. dash.cloudflare.com → Workers 和 Pages → 创建 → Worker → 随便起个名 → 部署
 * 2. 点进这个 Worker → 设置 → 绑定 → 添加绑定 → KV 命名空间：
 *    新建命名空间取名 gold-prices，变量名填 GOLD_KV
 * 3. 设置 → 触发器 → 添加 Cron 触发器：每30分钟一次
 * 4. 把下面代码粘进「代码」编辑器 → 保存并部署
 *
 * 数据源：gold-api.com（主）/ goldprice.dev（备），汇率：open.er-api.com
 *
 * Telegram 推送（可选）：
 * 1. Telegram 里找 @BotFather → /newbot 建机器人，拿到 token
 * 2. 找 @userinfobot 发任意消息，拿到你的 chat id（纯数字）
 * 3. Worker → 设置 → 变量 → 添加变量：
 *    TG_BOT_TOKEN（点加密）= 机器人 token
 *    TG_CHAT_ID（点加密）= 你的 chat id
 *    ALERT_HIGH = 涨破报警线，如 4100（可选）
 *    ALERT_LOW  = 跌破报警线，如 3950（可选）
 * 价格穿越报警线时发 Telegram 消息，回到区间内自动复位（避免重复打扰）
 */

const GOLD_API = "https://api.gold-api.com/price/XAU";
const GOLD_API_FB = "https://api.goldprice.dev/v1/prices?symbol=XAU-USD-SPOT";
const FX_API = "https://open.er-api.com/v6/latest/USD";
const OZ_TO_G = 31.1034768;
const MAX_POINTS = 2880; // 30分钟一次 ≈ 存60天

async function fetchGold() {
  try {
    const r = await fetch(GOLD_API, { headers: { "User-Agent": "gold-monitor/1.0" } });
    if (r.ok) { const j = await r.json(); if (j.price) return { price: j.price, src: "gold-api.com" }; }
  } catch (e) {}
  try {
    const r = await fetch(GOLD_API_FB, { headers: { "User-Agent": "gold-monitor/1.0" } });
    if (r.ok) {
      const j = await r.json(); const s = j.symbols && j.symbols[0];
      if (s && s.price) return { price: parseFloat(s.price), src: "goldprice.dev" };
    }
  } catch (e) {}
  return null;
}

async function fetchFX(env) {
  try {
    const cached = await env.GOLD_KV.get("usdcny", "json");
    if (cached && Date.now() - cached.at < 12 * 3600 * 1000) return cached.rate;
    const r = await fetch(FX_API);
    if (r.ok) {
      const j = await r.json();
      if (j.rates && j.rates.CNY) {
        await env.GOLD_KV.put("usdcny", JSON.stringify({ rate: j.rates.CNY, at: Date.now() }));
        return j.rates.CNY;
      }
    }
  } catch (e) {}
  return (await env.GOLD_KV.get("usdcny", "json") || {}).rate || 7.1;
}

async function sendTelegram(env, text) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return false;
  try {
    const r = await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: text })
    });
    return r.ok;
  } catch (e) { return false; }
}

// 价格穿越报警线时推送一次，回到区间内复位，避免每30分钟重复打扰
async function checkTelegramAlert(env, price) {
  const high = parseFloat(env.ALERT_HIGH), low = parseFloat(env.ALERT_LOW);
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  if (!high && !low) return;
  const state = (await env.GOLD_KV.get("tg_alert_state", "json")) || {};
  let msg = null;
  if (high && price >= high && state.last !== "high") {
    msg = "🔔 金价涨破 " + high + " USD/oz\n当前 " + price.toFixed(2) + " USD/oz";
    state.last = "high";
  } else if (low && price <= low && state.last !== "low") {
    msg = "🔔 金价跌破 " + low + " USD/oz\n当前 " + price.toFixed(2) + " USD/oz";
    state.last = "low";
  } else if (state.last && (!high || price < high) && (!low || price > low)) {
    state.last = null; // 回到区间内，复位
  } else {
    return; // 无变化，不写 KV
  }
  await env.GOLD_KV.put("tg_alert_state", JSON.stringify(state));
  if (msg) await sendTelegram(env, msg);
}

async function handleScheduled(env) {
  const g = await fetchGold();
  if (!g) return;
  const now = Date.now();
  await env.GOLD_KV.put("latest", JSON.stringify({ ...g, fetchedAt: now }));
  let hist = (await env.GOLD_KV.get("history", "json")) || [];
  hist.push({ t: now, p: Math.round(g.price * 100) / 100 });
  if (hist.length > MAX_POINTS) hist = hist.slice(-MAX_POINTS);
  await env.GOLD_KV.put("history", JSON.stringify(hist));
  await fetchFX(env); // 顺手刷新汇率
  await checkTelegramAlert(env, g.price);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function handleApi(url, env) {
  const path = url.pathname;
  if (path === "/api/latest") {
    const latest = (await env.GOLD_KV.get("latest", "json")) || null;
    const fx = await fetchFX(env);
    if (!latest) return json({ ok: false, msg: "暂无数据，等第一次定时抓取" });
    const cnyPerG = (latest.price / OZ_TO_G) * fx;
    return json({ ok: true, usd: latest.price, cnyPerG: Math.round(cnyPerG * 100) / 100,
      fx, src: latest.src, at: latest.fetchedAt });
  }
  if (path === "/api/history") {
    const hist = (await env.GOLD_KV.get("history", "json")) || [];
    const range = url.searchParams.get("range") || "all";
    const now = Date.now();
    const ms = { "24h": 864e5, "7d": 7 * 864e5, "30d": 30 * 864e5 }[range];
    const data = ms ? hist.filter(p => now - p.t <= ms) : hist;
    return json({ ok: true, count: data.length, data });
  }
  return json({ ok: false, msg: "unknown api" }, 404);
}

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>金价监听站</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0b0e17;color:#e8edf7;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh}
.wrap{max-width:860px;margin:0 auto;padding:28px 18px 60px}
h1{font-size:22px;font-weight:800;margin-bottom:4px}
.sub{color:#8b93b0;font-size:13px;margin-bottom:22px}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px}
.card{background:#12162a;border:1px solid #262a3d;border-radius:14px;padding:18px}
.card .k{font-size:12px;color:#8b93b0;margin-bottom:8px}
.card .v{font-size:30px;font-weight:800;font-variant-numeric:tabular-nums}
.card .v small{font-size:14px;color:#8b93b0;font-weight:400}
.up{color:#3ddc84}.down{color:#ff7b8a}
.chart-box{background:#12162a;border:1px solid #262a3d;border-radius:14px;padding:18px;margin-bottom:18px}
.ranges{display:flex;gap:8px;margin-bottom:12px}
.ranges button{background:#1a1e2e;border:1px solid #2c3247;color:#9aa3c0;border-radius:8px;padding:6px 14px;cursor:pointer;font-size:13px}
.ranges button.on{background:#22c55e;border-color:#22c55e;color:#06120a;font-weight:700}
#chart{width:100%;height:260px;display:block}
.alert{background:#12162a;border:1px solid #262a3d;border-radius:14px;padding:18px}
.alert h2{font-size:16px;margin-bottom:12px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.row label{font-size:13px;color:#8b93b0}
.row input{background:#0b0e17;border:1px solid #2c3247;color:#e8edf7;border-radius:8px;padding:8px 12px;width:130px;font-size:14px}
.row button{background:#22c55e;border:0;color:#06120a;border-radius:8px;padding:9px 18px;font-weight:700;cursor:pointer}
.row button.ghost{background:transparent;color:#9aa3c0;border:1px solid #333a55}
.note{font-size:12px;color:#6b7390;margin-top:8px}
.banner{display:none;background:#3a2b00;border:1px solid #8a6d00;color:#ffd93d;border-radius:10px;padding:12px 16px;margin-bottom:18px;font-weight:700}
.foot{margin-top:26px;font-size:12px;color:#6b7390;text-align:center}
@media(max-width:560px){.cards{grid-template-columns:1fr}.card .v{font-size:26px}}
</style></head>
<body><div class="wrap">
<h1>金价监听站 <span style="font-size:13px;color:#8b93b0;font-weight:400">XAU/USD 现货</span></h1>
<p class="sub" id="upd">加载中…</p>
<div class="banner" id="banner"></div>
<div class="cards">
  <div class="card"><div class="k">国际现货金价</div><div class="v"><span id="pUsd">—</span> <small>USD/oz</small></div><div class="k" id="pChg" style="margin:8px 0 0"></div></div>
  <div class="card"><div class="k">人民币计价</div><div class="v"><span id="pCny">—</span> <small>元/克</small></div><div class="k" style="margin:8px 0 0" id="pFx"></div></div>
</div>
<div class="chart-box">
  <div class="ranges">
    <button data-r="24h" class="on">24小时</button><button data-r="7d">7天</button><button data-r="30d">30天</button><button data-r="all">全部</button>
  </div>
  <canvas id="chart"></canvas>
</div>
<div class="alert">
  <h2>价格预警 <span style="font-size:12px;color:#8b93b0;font-weight:400">（保存在本浏览器，打开页面时检查）</span></h2>
  <div class="row"><label>高于</label><input id="aHigh" type="number" placeholder="USD/oz"><label>低于</label><input id="aLow" type="number" placeholder="USD/oz">
  <button id="aSave">保存预警</button><button class="ghost" id="aClear">清除</button></div>
  <p class="note" id="aStatus">未设置</p>
  <p class="note">要手机推送？在 Worker 的「设置 → 变量」里配好 TG_BOT_TOKEN、TG_CHAT_ID 和 ALERT_HIGH / ALERT_LOW，价格穿越报警线时机器人会自动发 Telegram 消息（代码头部有详细步骤）。</p>
</div>
<p class="foot">数据每30分钟自动抓取 · 源 gold-api.com · 仅供参考，不构成投资建议</p>
</div>
<script>
const $=id=>document.getElementById(id);
let range='24h', lastUsd=null;
async function load(){
  try{
    const r=await fetch('/api/latest'); const j=await r.json();
    if(!j.ok){$('upd').textContent=j.msg;return;}
    lastUsd=j.usd;
    $('pUsd').textContent=j.usd.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    $('pCny').textContent=j.cnyPerG.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    $('pFx').textContent='美元兑人民币 '+j.fx;
    $('upd').textContent='更新于 '+new Date(j.at).toLocaleString('zh-CN')+' · 来源 '+j.src;
    drawChart(); checkAlert();
  }catch(e){$('upd').textContent='加载失败，稍后重试';}
}
async function drawChart(){
  const r=await fetch('/api/history?range='+range); const j=await r.json();
  const d=j.data||[]; const cv=$('chart'), ctx=cv.getContext('2d');
  const W=cv.clientWidth,H=cv.clientHeight,dpr=devicePixelRatio||1;
  cv.width=W*dpr;cv.height=H*dpr;ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,W,H);
  if(d.length<2){ctx.fillStyle='#6b7390';ctx.font='14px sans-serif';ctx.fillText('数据积累中…',20,40);return;}
  const ps=d.map(p=>p.p),ts=d.map(p=>p.t);
  let mn=Math.min(...ps),mx=Math.max(...ps); const pad=(mx-mn)*0.15||1; mn-=pad;mx+=pad;
  const t0=ts[0],t1=ts[ts.length-1]||t0+1;
  const X=t=>8+(t-t0)/(t1-t0)*(W-16), Y=p=>H-24-(p-mn)/(mx-mn)*(H-48);
  // 网格
  ctx.strokeStyle='#1c2133';ctx.lineWidth=1;
  for(let i=0;i<=4;i++){const y=12+i*(H-48)/4;ctx.beginPath();ctx.moveTo(8,y);ctx.lineTo(W-8,y);ctx.stroke();
    ctx.fillStyle='#6b7390';ctx.font='11px sans-serif';ctx.fillText((mx-(mx-mn)*i/4).toFixed(0),10,y-4);}
  // 面积
  const gr=ctx.createLinearGradient(0,0,0,H);gr.addColorStop(0,'rgba(255,217,61,.25)');gr.addColorStop(1,'rgba(255,217,61,0)');
  ctx.beginPath();d.forEach((p,i)=>{const x=X(p.t),y=Y(p.p);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
  ctx.lineTo(X(t1),H-24);ctx.lineTo(X(t0),H-24);ctx.closePath();ctx.fillStyle=gr;ctx.fill();
  // 线
  ctx.beginPath();d.forEach((p,i)=>{const x=X(p.t),y=Y(p.p);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
  ctx.strokeStyle='#ffd93d';ctx.lineWidth=2;ctx.stroke();
  // 最后一笔
  const lx=X(t1),ly=Y(ps[ps.length-1]);
  ctx.fillStyle='#ffd93d';ctx.beginPath();ctx.arc(lx,ly,4,0,7);ctx.fill();
  ctx.fillStyle='#8b93b0';ctx.font='11px sans-serif';
  ctx.fillText(new Date(t0).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'}),8,H-8);
  const e=new Date(t1).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'});
  ctx.fillText(e,W-8-ctx.measureText(e).width,H-8);
  // 24h涨跌
  const dayAgo=Date.now()-864e5; const old=d.find(p=>p.t>=dayAgo);
  if(old){const chg=ps[ps.length-1]-old.p,pct=chg/old.p*100;
    $('pChg').innerHTML='<span class="'+(chg>=0?'up':'down')+'">'+(chg>=0?'▲ +':'▼ ')+chg.toFixed(2)+' ('+pct.toFixed(2)+'%)</span> 24h';}
}
function checkAlert(){
  const h=parseFloat(localStorage.getItem('gAlertH')), l=parseFloat(localStorage.getItem('gAlertL'));
  const b=$('banner'); b.style.display='none';
  if(lastUsd==null)return;
  if(h&&lastUsd>=h){b.style.display='block';b.textContent='🔔 金价已涨破 '+h+' USD/oz，当前 '+lastUsd.toFixed(2);}
  else if(l&&lastUsd<=l){b.style.display='block';b.textContent='🔔 金价已跌破 '+l+' USD/oz，当前 '+lastUsd.toFixed(2);}
}
function refreshAStatus(){
  const h=localStorage.getItem('gAlertH'),l=localStorage.getItem('gAlertL');
  $('aStatus').textContent=(h||l)?('已设置：'+(h?('高于 '+h):'')+(h&&l?'，':'')+(l?('低于 '+l):'')):'未设置';
  if(h)$('aHigh').value=h; if(l)$('aLow').value=l;
}
document.querySelectorAll('.ranges button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.ranges button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');range=b.dataset.r;drawChart();});
$('aSave').onclick=()=>{const h=$('aHigh').value,l=$('aLow').value;
  h?localStorage.setItem('gAlertH',h):localStorage.removeItem('gAlertH');
  l?localStorage.setItem('gAlertL',l):localStorage.removeItem('gAlertL');
  refreshAStatus();checkAlert();};
$('aClear').onclick=()=>{localStorage.removeItem('gAlertH');localStorage.removeItem('gAlertL');
  $('aHigh').value='';$('aLow').value='';refreshAStatus();$('banner').style.display='none';};
refreshAStatus();load();setInterval(load,60000);
</script></body></html>`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return handleApi(url, env);
    return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  }
};
