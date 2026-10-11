import { renderStackedArea } from './chart.js';

const PALETTE = [
  '#5b8def',
  '#3ecf8e',
  '#f5a524',
  '#e35d6a',
  '#a78bfa',
  '#22d3ee',
  '#f472b6',
  '#84cc16',
];

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${url} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function fmtGb(n, digits = 1) {
  if (n == null || Number.isNaN(Number(n))) return '-';
  return Number(n).toFixed(digits);
}

function fmtSigned(n) {
  const v = Number(n) || 0;
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)} GB`;
}

function formatAgo(sec) {
  if (sec == null) return 'never';
  const age = Math.max(0, Math.floor(Date.now() / 1000) - Number(sec));
  if (age < 60) return `${age}s ago`;
  const min = Math.floor(age / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} hr ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function durationSince(sec) {
  if (sec == null) return '-';
  const age = Math.max(0, Math.floor(Date.now() / 1000) - Number(sec));
  const min = Math.floor(age / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function freeTone(freeGb) {
  if (freeGb >= 80) return 'green';
  if (freeGb >= 40) return 'amber';
  return 'red';
}

function setRing(freeGb, totalGb) {
  const ring = document.getElementById('free-ring');
  const freeEl = document.getElementById('free-gb');
  freeEl.textContent = fmtGb(freeGb, 1);
  const tone = freeTone(freeGb);
  ring.classList.remove('amber', 'red', 'pulse');
  if (tone === 'amber') ring.classList.add('amber');
  if (tone === 'red') ring.classList.add('red');
  if (freeGb < 20) ring.classList.add('pulse');
  const pct = totalGb > 0 ? Math.max(2, Math.min(100, (freeGb / totalGb) * 100)) : 0;
  ring.style.setProperty('--pct', `${pct}%`);
}

function renderMovers(tbody, movers) {
  tbody.innerHTML = '';
  if (!movers || movers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">No movers yet</td></tr>';
    return;
  }
  for (const m of movers) {
    const tr = document.createElement('tr');
    const d1 = Number(m.delta_1d_gb) || 0;
    const d7 = Number(m.delta_7d_gb ?? m.delta_period_gb) || 0;
    tr.innerHTML = `
      <td class="path">${escapeHtml(m.path)}</td>
      <td><span class="class-chip">${escapeHtml(m.class || 'unknown')}</span></td>
      <td>${fmtGb(m.size_gb, 2)} GB</td>
      <td class="${d1 >= 0 ? 'delta-pos' : 'delta-neg'}">${fmtSigned(d1)}</td>
      <td class="${d7 >= 0 ? 'delta-pos' : 'delta-neg'}">${fmtSigned(d7)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderEvents(listEl, events) {
  listEl.innerHTML = '';
  if (!events || events.length === 0) {
    listEl.innerHTML = '<li class="muted">No open events</li>';
    return;
  }
  for (const e of events) {
    const li = document.createElement('li');
    const sev = e.severity === 'critical' ? 'critical' : 'warn';
    const since = e.at != null ? durationSince(e.at) : '-';
    li.innerHTML = `
      <div>
        <span class="sev ${sev}">${escapeHtml(e.severity || 'warn')}</span>
        <strong>${escapeHtml(e.headline || e.kind)}</strong>
      </div>
      <div class="meta">
        ${escapeHtml(e.kind || '')}
        ${e.path ? ' · ' + escapeHtml(e.path) : ''}
        · open ${since}
        ${e.count && e.count > 1 ? ` · seen ×${e.count}` : ''}
      </div>
    `;
    listEl.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderLegend(series) {
  const el = document.getElementById('chart-legend');
  el.innerHTML = '';
  series.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<span class="swatch" style="background:${PALETTE[i % PALETTE.length]}"></span>${escapeHtml(s.path)}`;
    el.appendChild(item);
  });
}

function applyTriage(status) {
  const card = document.getElementById('triage');
  const chartPanel = document.getElementById('chart-panel');
  const triage = Boolean(status?.data?.triage);
  card.classList.toggle('show', triage);

  if (triage) {
    // Move chart below triage: triage already precedes header; move chart after triage content order in DOM.
    // Ensure triage is the top content block after banner.
    const banner = document.getElementById('doctor-banner');
    banner.insertAdjacentElement('afterend', card);
    card.insertAdjacentElement('afterend', document.querySelector('.header-card'));
    document.querySelector('.header-card').insertAdjacentElement('afterend', chartPanel);

    document.getElementById('triage-restart').textContent =
      `A restart reclaims about ${fmtGb(status.data.restart_reclaim_gb, 1)} GB`;
    const movers = document.getElementById('triage-movers');
    movers.innerHTML = '';
    for (const m of (status.data.top_movers || []).slice(0, 5)) {
      const li = document.createElement('li');
      li.textContent = `${m.path}  ${fmtSigned(m.delta_1d_gb)}`;
      movers.appendChild(li);
    }
    if (!movers.children.length) movers.innerHTML = '<li class="muted">None</li>';

    const ev = document.getElementById('triage-events');
    renderEvents(ev, status.data.open_events || []);
  }
}

function applyDoctor(doctor) {
  const chip = document.getElementById('health-chip');
  const banner = document.getElementById('doctor-banner');
  const status = doctor?.status || 'ok';
  chip.textContent = `health ${status}`;
  chip.classList.remove('ok', 'warn', 'fail');
  chip.classList.add(status === 'fail' ? 'fail' : status === 'warn' ? 'warn' : 'ok');

  const failing = doctor?.failing || [];
  if (status === 'fail' && failing.length) {
    banner.classList.add('show');
    banner.textContent = `Doctor FAIL: ${failing.join(', ')}. See diskwatch doctor --json`;
  } else {
    banner.classList.remove('show');
    banner.textContent = '';
  }
}

async function refresh() {
  const [status, timeseries, movers, events, doctor] = await Promise.all([
    getJson('/api/status'),
    getJson('/api/timeseries?days=14&top=8'),
    getJson('/api/movers?since=1d'),
    getJson('/api/events?limit=50'),
    getJson('/api/doctor'),
  ]);

  const d = status.data || {};
  setRing(d.free_gb ?? 0, d.total_gb ?? 0);
  document.getElementById('volume-line').textContent =
    `Free ${fmtGb(d.free_gb)} GB of ${fmtGb(d.total_gb)} GB`;
  document.getElementById('swap-line').textContent = `Swap ${fmtGb(d.swap_gb)} GB`;
  document.getElementById('restart-line').textContent =
    `A restart reclaims about ${fmtGb(d.restart_reclaim_gb, 1)} GB`;
  document.getElementById('scan-line').textContent =
    `Last scan ${formatAgo(status.as_of)}` +
    (status.stale ? ' · STALE' : '') +
    (d.trend_24h_gb != null ? ` · 24h free Δ ${fmtSigned(d.trend_24h_gb)}` : '');

  applyDoctor(doctor.status ? doctor : status.doctor);
  applyTriage(status);

  const svg = document.getElementById('chart');
  // Fit width to container.
  const wrap = document.getElementById('chart-wrap');
  svg.setAttribute('width', String(Math.max(480, wrap.clientWidth || 960)));
  renderStackedArea(svg, timeseries);
  renderLegend(timeseries.series || []);

  renderMovers(document.getElementById('movers-body'), movers.movers || d.top_movers || []);
  const openOnly = (events.events || []).filter((e) => e.open);
  renderEvents(document.getElementById('events-list'), openOnly.length ? openOnly : d.open_events || []);
}

refresh().catch((err) => {
  const banner = document.getElementById('doctor-banner');
  banner.classList.add('show');
  banner.textContent = `Dashboard load failed: ${err.message || err}`;
  document.getElementById('health-chip').textContent = 'health fail';
  document.getElementById('health-chip').classList.add('fail');
});

setInterval(() => {
  refresh().catch(() => {});
}, 60_000);
