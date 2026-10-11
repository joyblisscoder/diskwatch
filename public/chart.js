/**
 * Hand-written stacked area chart. No libraries.
 * seriesData: { days: string[], series: [{ path, class, points: [{day,size_gb}] }] }
 */

const PALETTE = [
  '#5b8def', '#3ecf8e', '#f5a524', '#e35d6a',
  '#a78bfa', '#22d3ee', '#f472b6', '#84cc16',
];

function ensureSvg(target) {
  if (typeof target === 'string') {
    const el = document.querySelector(target);
    if (!el) throw new Error(`chart target not found: ${target}`);
    target = el;
  }
  if (target instanceof SVGElement) return target;
  let svg = target.querySelector('svg');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    target.appendChild(svg);
  }
  return svg;
}

function stackSeries(seriesData) {
  const days = seriesData.days || [];
  const series = seriesData.series || [];
  const stacks = days.map((day, di) => {
    let y0 = 0;
    const layers = series.map((s) => {
      const v = Number(((s.points || [])[di] || {}).size_gb) || 0;
      const y1 = y0 + v;
      const layer = { y0, y1, v };
      y0 = y1;
      return layer;
    });
    return { day, total: y0, layers };
  });
  return { days, series, stacks, maxY: Math.max(1, ...stacks.map((s) => s.total)) };
}

function areaPath(points) {
  if (!points.length) return '';
  const top = points.map((p) => `${p.x},${p.yTop}`).join(' L ');
  const bottom = [...points].reverse().map((p) => `${p.x},${p.yBot}`).join(' L ');
  return `M ${top} L ${bottom} Z`;
}

/** Render a stacked area chart into an SVG element or container. */
export function renderStackedArea(svgOrContainer, seriesData) {
  const svg = ensureSvg(svgOrContainer);
  const { days, series, stacks, maxY } = stackSeries(seriesData || { days: [], series: [] });
  const width = Number(svg.getAttribute('width')) || svg.clientWidth || 720;
  const height = Number(svg.getAttribute('height')) || svg.clientHeight || 260;
  const pad = { top: 16, right: 12, bottom: 36, left: 48 };
  const innerW = Math.max(10, width - pad.left - pad.right);
  const innerH = Math.max(10, height - pad.top - pad.bottom);
  const n = Math.max(1, days.length - 1);
  const xAt = (i) => pad.left + (i / n) * innerW;
  const yAt = (v) => pad.top + innerH - (v / maxY) * innerH;

  while (svg.firstChild) svg.removeChild(svg.firstChild);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Disk usage stacked area (logical)');

  for (let g = 0; g <= 4; g++) {
    const gy = pad.top + (innerH * g) / 4;
    const line = document.createElementNS(svg.namespaceURI, 'line');
    line.setAttribute('x1', String(pad.left));
    line.setAttribute('x2', String(width - pad.right));
    line.setAttribute('y1', String(gy));
    line.setAttribute('y2', String(gy));
    line.setAttribute('class', 'chart-grid');
    svg.appendChild(line);
    const label = document.createElementNS(svg.namespaceURI, 'text');
    const val = maxY * (1 - g / 4);
    label.setAttribute('x', String(pad.left - 8));
    label.setAttribute('y', String(gy + 4));
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('class', 'chart-axis');
    label.textContent = val >= 10 ? val.toFixed(0) : val.toFixed(1);
    svg.appendChild(label);
  }

  for (let si = 0; si < series.length; si++) {
    const pts = stacks.map((st, i) => ({
      x: xAt(i),
      yTop: yAt(st.layers[si].y1),
      yBot: yAt(st.layers[si].y0),
    }));
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', areaPath(pts));
    path.setAttribute('fill', PALETTE[si % PALETTE.length]);
    path.setAttribute('fill-opacity', '0.72');
    path.setAttribute('stroke', PALETTE[si % PALETTE.length]);
    path.setAttribute('stroke-width', '1');
    path.setAttribute('class', 'chart-area');
    path.setAttribute('data-path', series[si].path || '');
    svg.appendChild(path);
  }

  const labelIdx = [...new Set(
    [0, Math.floor(days.length / 2), days.length - 1].filter((i) => i >= 0 && i < days.length),
  )];
  for (const i of labelIdx) {
    const text = document.createElementNS(svg.namespaceURI, 'text');
    text.setAttribute('x', String(xAt(i)));
    text.setAttribute('y', String(height - 12));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('class', 'chart-axis');
    text.textContent = (days[i] || '').slice(5);
    svg.appendChild(text);
  }

  return { maxY, seriesCount: series.length };
}
