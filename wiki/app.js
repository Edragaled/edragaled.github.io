/* Pixel Chronicles wiki — hash router over the JSON emitted by wiki/tools/extract.mjs.
   No build step, no dependencies: this file is served as-is. */

'use strict';

const DB = { items: [], monsters: [], loot: [], recipes: [], sets: [], buildings: [], gamemodes: [], talents: [], statuses: [], skilltree: null, meta: null };
const IX = {
  item: new Map(), monster: new Map(), loot: new Map(), recipe: new Map(),
  set: new Map(), building: new Map(), mode: new Map(), chapter: new Map(),
};

const view = document.getElementById('view');
const searchInput = document.getElementById('search');
const suggestions = document.getElementById('suggestions');

/* ------------------------------------------------------------ localization
   Game text is translated in the payload itself — a language is a whole data
   set, so `DB.items[0].name` is already in the right language. Only the wiki's
   own chrome and the vocabulary labels are looked up here. */

const LANG_KEY = 'pc-wiki-lang';

/** The language whose payloads are loaded. Set before any render happens. */
let LANG = 'en';

/**
 * A chrome string, with `{name}` placeholders filled from `vars`.
 * Falls back to the key itself, which is ugly on purpose: a missing string should
 * be obvious on the page rather than render as an empty gap.
 */
function t(key, vars) {
  const raw = DB.meta?.strings?.[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

/** Plural helper: `{n} tables` / `1 table` share a key plus a `.one` variant. */
const tn = (key, n, vars) => t(n === 1 && DB.meta?.strings?.[`${key}.one`] ? `${key}.one` : key, { n: nf(n), ...vars });

/**
 * A vocabulary label. The payloads carry the project's own identifiers so a
 * filter in the URL survives a language change; the label is translated here.
 */
const lb = (kind, value) => (value == null || value === ''
  ? '—'
  : DB.meta?.labels?.[kind]?.[value] ?? value);

/** `chipGroup` renders labels but keeps the untranslated value in the hash. */
const labelsFor = (kind, values) => Object.fromEntries(values.map((v) => [v, lb(kind, v)]));

/* ------------------------------------------------------------------- utils */

const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const slug = (s) => encodeURIComponent(String(s));
const cls = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
const nf = (n) => (n == null ? '—' : Number(n).toLocaleString(LANG));
/** Names sort by the reader's alphabet, not by code-point order. */
const byName = (a, b) => String(a).localeCompare(String(b), LANG);
const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Game text carries Unity rich-text tags; strip them rather than render them. */
const plain = (s) => String(s ?? '').replace(/<\/?(?:color|link|size|b|i|u|sprite)[^>]*>/gi, '').replace(/\s+/g, ' ').trim();

/**
 * Every icon URL passes through here. Served normally they stay relative paths;
 * the single-file preview built by `wiki/tools/bundle.mjs` populates
 * `window.__WIKI_ICONS__` with inline data URIs instead.
 */
const iconSrc = (path) => window.__WIKI_ICONS__?.[path] ?? path;

/**
 * An icon is either a path, or `{ src, crop }` when the artwork is one cell of a
 * sprite sheet — the trees, cacti and swamp trunks all share an animation sheet,
 * and showing the file would show every frame at once.
 *
 * The crop is done with percentages so it holds at any rendered size: the outer
 * span carries the sprite's aspect ratio and clips, and the image inside is blown
 * up to `sheet / cell` and offset by the cell's position.
 */
function iconImg(icon, alt = '') {
  if (!icon) return '';
  if (typeof icon === 'string') {
    return `<img src="${esc(iconSrc(icon))}" alt="${esc(alt)}" loading="lazy" decoding="async">`;
  }

  const { src, crop: c } = icon;
  const pct = (n) => Math.round(n * 1e4) / 1e4;
  return `<span class="sprite" style="aspect-ratio:${c.w}/${c.h}"><img
    src="${esc(iconSrc(src))}" alt="${esc(alt)}" loading="lazy" decoding="async"
    style="width:${pct((c.sheetW / c.w) * 100)}%;height:${pct((c.sheetH / c.h) * 100)}%;left:${pct((-c.x / c.w) * 100)}%;top:${pct((-c.y / c.h) * 100)}%"></span>`;
}

function thumb(icon, alt, sizeClass = '') {
  if (!icon) return `<span class="thumb empty ${sizeClass}" role="img" aria-label="No icon"></span>`;
  return `<span class="thumb ${sizeClass}">${iconImg(icon, alt)}</span>`;
}

/** `scale` picks the game's item or monster palette — a Common item is white,
 *  a Common monster is green. */
const rarityBadge = (r, scale = 'item') => `<span class="badge rarity ${scale === 'monster' ? 'mr' : 'r'}-${cls(r)}">${esc(lb('rarity', r))}</span>`;

const elementBadge = (e, icon) => `<span class="badge element e-${cls(e)}">${
  icon ? iconImg(icon) : ''}${esc(lb('element', e))}</span>`;

const biomeBadges = (biomes) => (
  biomes?.length
    ? `<span class="biome-list">${biomes.map((b) => `<span class="badge">${esc(lb('biome', b))}</span>`).join('')}</span>`
    : '—'
);

function chanceCell(p) {
  if (p == null) return '<span class="chance">—</span>';
  return `<span class="chance"><i><b style="width:${Math.min(100, p)}%"></b></i>${p}%</span>`;
}

const amountsText = (amounts) => (
  !amounts?.length ? '1'
    : amounts.length === 1 ? String(amounts[0].amount)
      : amounts.map((a) => `${a.amount} (${a.chance}%)`).join(', ')
);

const linkItem = (key) => {
  const it = IX.item.get(key);
  return it ? `<a href="#/item/${slug(key)}">${esc(it.name)}</a>` : esc(key ?? '—');
};

/** `Workshop Lv.2` — the station name is translated, the level number is not. */
const stationText = (r) => `${lb('station', r.station)}${r.stationLevel ? ` ${t('col.level')}${r.stationLevel}` : ''}`;

/* ------------------------------------------------------------------ filters
   Filter state lives in the hash query so any filtered view is linkable. */

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(query) };
}

function setParam(key, value) {
  const { parts, params } = parseHash();
  if (value == null || value === '' || value === 'all') params.delete(key);
  else params.set(key, value);
  const q = params.toString();
  location.hash = `/${parts.map(encodeURIComponent).join('/')}${q ? `?${q}` : ''}`;
}

/** Renders a row of single-select chips bound to a hash parameter. */
function chipGroup(label, key, values, current, labels = {}) {
  const options = ['all', ...values];
  return `<div class="filter-group"><span>${esc(label)}</span>${options.map((v) => `
    <button type="button" class="chip" data-param="${esc(key)}" data-value="${esc(v)}"
            aria-pressed="${String(v === current)}">${esc(labels[v] ?? (v === 'all' ? t('filter.all') : v))}</button>`).join('')}</div>`;
}

function sortSelect(key, options, current) {
  return `<div class="filter-group"><span>${esc(t('filter.sort'))}</span><select class="chip" data-param="${esc(key)}">${
    options.map(([v, label]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(label)}</option>`).join('')
  }</select></div>`;
}

function wireFilters(root) {
  root.querySelectorAll('.chip[data-param][data-value]').forEach((btn) => {
    btn.addEventListener('click', () => setParam(btn.dataset.param, btn.dataset.value));
  });
  root.querySelectorAll('select.chip[data-param]').forEach((sel) => {
    sel.addEventListener('change', () => setParam(sel.dataset.param, sel.value));
  });
}

/** Click-to-sort table headers. `cols` entries: { label, num, sort, render }. */
function sortableTable(cols, rows, sortKey, dir, onSort) {
  const active = cols.find((c) => c.sort === sortKey);
  const sorted = rows.slice();
  if (active?.sort) {
    sorted.sort((a, b) => {
      const av = active.value(a);
      const bv = active.value(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const c = typeof av === 'number' && typeof bv === 'number' ? av - bv : byName(av, bv);
      return dir === 'desc' ? -c : c;
    });
  }

  const head = cols.map((c) => {
    const sortable = c.sort ? ' sortable' : '';
    const aria = c.sort === sortKey ? ` aria-sort="${dir === 'desc' ? 'descending' : 'ascending'}"` : '';
    return `<th class="${c.num ? 'num' : ''}${sortable}"${aria} data-sort="${esc(c.sort ?? '')}">${esc(c.label)}</th>`;
  }).join('');

  const body = sorted.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.render(r)}</td>`).join('')}</tr>`).join('');

  const frag = el(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
  frag.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => onSort(th.dataset.sort));
  });
  return frag;
}

/* -------------------------------------------------------------------- views */

function renderHome() {
  const c = DB.meta?.counts ?? {};
  const dropCount = DB.loot.reduce((n, t) => n + t.entries.length, 0);

  const featured = DB.monsters
    .filter((m) => m.rarityIndex >= 2)
    .sort((a, b) => b.stats.health - a.stats.health)
    .slice(0, 8);

  const frag = el(`<div>
    <div class="hero">
      <h1>${esc(t('home.title'))}</h1>
      <p class="subtitle">${esc(t('home.subtitle'))}</p>
    </div>

    <div class="stat-row">
      <a class="stat-tile" href="#/items"><b>${nf(c.items)}</b><span>${esc(t('home.tile.items'))}</span></a>
      <a class="stat-tile" href="#/monsters"><b>${nf(c.monsters)}</b><span>${esc(t('home.tile.monsters'))}</span></a>
      <a class="stat-tile" href="#/loot"><b>${nf(dropCount)}</b><span>${esc(t('home.tile.drops'))}</span></a>
      <a class="stat-tile" href="#/recipes"><b>${nf(c.recipes)}</b><span>${esc(t('home.tile.recipes'))}</span></a>
      <a class="stat-tile" href="#/buildings"><b>${nf(c.buildings)}</b><span>${esc(t('home.tile.buildings'))}</span></a>
      <a class="stat-tile" href="#/talents"><b>${nf(c.talents)}</b><span>${esc(t('home.tile.talents'))}</span></a>
      <a class="stat-tile" href="#/status"><b>${nf(c.statuses)}</b><span>${esc(t('home.tile.statuses'))}</span></a>
      <a class="stat-tile" href="#/tree"><b>${nf(c.skillTreeNodes)}</b><span>${esc(t('home.tile.tree'))}</span></a>
      <a class="stat-tile" href="#/modes"><b>${nf(c.levels)}</b><span>${esc(t('home.tile.levels'))}</span></a>
    </div>

    <h2>${esc(t('home.toughest'))}</h2>
    <div class="grid" id="featured"></div>

    <h2>${esc(t('home.bestGear'))}</h2>
    <div class="grid" id="best"></div>
  </div>`);

  frag.getElementById('featured').append(...featured.map(monsterCard));
  const best = DB.items.filter((i) => i.rarityIndex >= 4).slice(0, 12);
  frag.getElementById('best').append(...best.map(itemCard));
  return frag;
}

/** Slot is only informative for gear; elsewhere the category says more. */
const EQUIPPABLE = new Set(['Weapon', 'Armor']);
const itemKind = (i) => (EQUIPPABLE.has(i.category) && i.slot ? i.slot : i.tags[0]) ?? null;
/** The same value, translated — the raw one is still used for filtering. */
const itemLabel = (i) => (EQUIPPABLE.has(i.category) && i.slot ? lb('slot', i.slot) : lb('category', i.tags[0]));

const itemCard = (i) => el(`<a class="card r-${cls(i.rarity)}" href="#/item/${slug(i.key)}">
  ${thumb(i.icon, i.name)}
  <span class="card-body">
    <span class="card-title">${esc(i.name)}</span>
    <span class="card-sub">${esc(lb('rarity', i.rarity))}${itemKind(i) ? ` · ${esc(itemLabel(i))}` : ''}</span>
  </span></a>`);

const monsterCard = (m) => el(`<a class="card mr-${cls(m.rarity)}" href="#/monster/${slug(m.key)}">
  ${thumb(m.icon, m.name)}
  <span class="card-body">
    <span class="card-title">${esc(m.name)}</span>
    <span class="card-sub">${esc(lb('element', m.element))} · ${nf(m.stats.health)} ${esc(lb('stat', 'Max Health'))}</span>
  </span></a>`);

function renderItems(params) {
  const tag = params.get('tag') ?? 'all';
  const rarity = params.get('rarity') ?? 'all';
  const slot = params.get('slot') ?? 'all';
  const sort = params.get('sort') ?? 'name';

  let rows = DB.items;
  if (tag !== 'all') rows = rows.filter((i) => i.tags.includes(tag));
  if (rarity !== 'all') rows = rows.filter((i) => i.rarity === rarity);
  if (slot !== 'all') rows = rows.filter((i) => (i.slot ?? 'None') === slot);

  const sorters = {
    name: (a, b) => byName(a.name, b.name),
    rarity: (a, b) => b.rarityIndex - a.rarityIndex || byName(a.name, b.name),
    attack: (a, b) => (b.stats?.attack ?? 0) - (a.stats?.attack ?? 0),
    defense: (a, b) => (b.stats?.defense ?? 0) - (a.stats?.defense ?? 0),
    health: (a, b) => (b.stats?.health ?? 0) - (a.stats?.health ?? 0),
  };
  rows = rows.slice().sort(sorters[sort] ?? sorters.name);

  const tags = [...new Set(DB.items.flatMap((i) => i.tags))].sort();
  const slots = [...new Set(DB.items.map((i) => i.slot).filter(Boolean))].sort();

  const frag = el(`<div>
    <h1>${esc(t('items.title'))}</h1>
    <p class="subtitle">${esc(t('items.subtitle', { n: nf(DB.items.length) }))}</p>
    <div class="filters">
      ${chipGroup(t('filter.type'), 'tag', tags, tag, labelsFor('category', tags))}
      ${chipGroup(t('filter.rarity'), 'rarity', DB.meta.rarities, rarity, labelsFor('rarity', DB.meta.rarities))}
      ${chipGroup(t('filter.slot'), 'slot', slots, slot, labelsFor('slot', slots))}
      ${sortSelect('sort', [['name', t('sort.name')], ['rarity', t('sort.rarity')], ['attack', t('sort.attack')], ['defense', t('sort.defense')], ['health', t('sort.health')]], sort)}
      <span class="count">${esc(t('filter.shown', { n: nf(rows.length) }))}</span>
    </div>
    <div class="grid" id="list"></div>
    ${rows.length ? '' : `<p class="empty-note">${esc(t('items.empty'))}</p>`}
  </div>`);

  frag.getElementById('list').append(...rows.map(itemCard));
  wireFilters(frag);
  return frag;
}

function renderMonsters(params) {
  const element = params.get('element') ?? 'all';
  const rarity = params.get('rarity') ?? 'all';
  const env = params.get('env') ?? 'all';
  const sort = params.get('sort') ?? 'name';
  const dir = params.get('dir') ?? (sort === 'name' ? 'asc' : 'desc');

  let rows = DB.monsters;
  if (element !== 'all') rows = rows.filter((m) => m.element === element);
  if (rarity !== 'all') rows = rows.filter((m) => m.rarity === rarity);
  if (env !== 'all') rows = rows.filter((m) => m.environment === env);

  const envs = [...new Set(DB.monsters.map((m) => m.environment).filter(Boolean))].sort();

  const cols = [
    { label: t('col.monster'), sort: 'name', value: (m) => m.name, render: (m) => `<span class="with-icon">${iconImg(m.icon)}<a href="#/monster/${slug(m.key)}">${esc(m.name)}</a></span>` },
    { label: t('filter.element'), sort: 'element', value: (m) => m.element, render: (m) => elementBadge(m.element, m.elementIcon) },
    { label: t('col.rarity'), sort: 'rarity', value: (m) => m.rarityIndex, render: (m) => rarityBadge(m.rarity, 'monster') },
    { label: t('col.biome'), sort: 'env', value: (m) => m.environment, render: (m) => esc(lb('biome', m.environment)) },
    { label: lb('stat', 'Max Health'), num: true, sort: 'health', value: (m) => m.stats.health, render: (m) => nf(m.stats.health) },
    { label: lb('stat', 'Attack'), num: true, sort: 'attack', value: (m) => m.stats.attack, render: (m) => nf(m.stats.attack) },
    { label: lb('stat', 'Defense'), num: true, sort: 'defense', value: (m) => m.stats.defense, render: (m) => nf(m.stats.defense) },
    { label: lb('stat', 'Attack Speed'), num: true, sort: 'speed', value: (m) => m.stats.attackSpeed, render: (m) => (m.stats.attackSpeed == null ? '—' : round(m.stats.attackSpeed).toFixed(2)) },
    { label: t('col.drops'), num: true, sort: 'drops', value: (m) => (IX.loot.get(m.lootTable)?.entries.length ?? 0), render: (m) => (m.lootTable ? `<a href="#/loot/${slug(m.lootTable)}">${IX.loot.get(m.lootTable).entries.length}</a>` : '—') },
  ];

  const frag = el(`<div>
    <h1>${esc(t('monsters.title'))}</h1>
    <p class="subtitle">${esc(t('monsters.subtitle', {
    n: nf(DB.monsters.length),
    summonable: nf(DB.monsters.filter((m) => m.summonable).length),
  }))}</p>
    <div class="filters">
      ${chipGroup(t('filter.element'), 'element', DB.meta.elements, element, labelsFor('element', DB.meta.elements))}
      ${chipGroup(t('filter.rarity'), 'rarity', DB.meta.monsterRarities, rarity, labelsFor('rarity', DB.meta.monsterRarities))}
      ${chipGroup(t('filter.biome'), 'env', envs, env, labelsFor('biome', envs))}
      <span class="count">${esc(t('filter.shown', { n: nf(rows.length) }))}</span>
    </div>
    <div id="table"></div>
  </div>`);

  frag.getElementById('table').append(sortableTable(cols, rows, sort, dir, (key) => {
    const nextDir = key === sort && dir === 'asc' ? 'desc' : key === sort ? 'asc' : (key === 'name' ? 'asc' : 'desc');
    const { parts, params: p } = parseHash();
    p.set('sort', key); p.set('dir', nextDir);
    location.hash = `/${parts.join('/')}?${p}`;
  }));
  wireFilters(frag);
  return frag;
}

function renderItemDetail(key) {
  const i = IX.item.get(key);
  if (!i) return notFound('item', key);

  const set = i.set ? IX.set.get(i.set) : null;
  const recipes = i.craftedBy.map((id) => IX.recipe.get(id)).filter(Boolean);
  const usedIn = i.usedIn.map((id) => IX.recipe.get(id)).filter(Boolean);
  const drops = i.droppedBy.slice().sort((a, b) => (b.chance.normal ?? 0) - (a.chance.normal ?? 0));

  const statRows = i.stats ? [
    [t('sort.attack'), i.stats.attack],
    [t('sort.defense'), i.stats.defense],
    [t('sort.health'), i.stats.health],
    [t('monster.attackSpeed'), i.stats.attackSpeed == null ? null : round(i.stats.attackSpeed).toFixed(2)],
  ].filter(([, v]) => v) : [];

  const frag = el(`<div>
    <p class="crumbs"><a href="#/items">${esc(t('items.title'))}</a>${i.tags.length ? ` <span class="arrow">/</span> ${esc(lb('category', i.tags[0]))}` : ''}</p>

    <div class="detail-head">
      ${thumb(i.icon, i.name)}
      <div>
        <h1>${esc(i.name)}</h1>
        <div class="detail-meta">
          ${rarityBadge(i.rarity)}
          ${i.tags.map((tag) => `<span class="badge">${esc(lb('category', tag))}</span>`).join('')}
          ${i.slot ? `<span class="badge">${esc(lb('slot', i.slot))}</span>` : ''}
          ${i.maxStack > 1 ? `<span class="badge">${esc(t('item.stacks', { n: nf(i.maxStack) }))}</span>` : ''}
          ${i.upgradable && i.slot ? `<span class="badge">${esc(t('item.upgradable'))}</span>` : ''}
        </div>
      </div>
    </div>

    <div class="panels">
      ${statRows.length || i.tool ? `<section class="panel">
        <h3>${esc(t('item.stats'))}</h3>
        <dl class="stats">
          ${statRows.map(([label, v]) => `<div><dt>${esc(label)}</dt><dd>${esc(v)}</dd></div>`).join('')}
          ${i.maxCharges ? `<div><dt>${esc(t('item.skillCharges'))}</dt><dd>${nf(i.maxCharges)}</dd></div>` : ''}
          ${i.tool ? `
            <div><dt>${esc(t('item.toolType'))}</dt><dd>${esc(i.tool.type)}</dd></div>
            <div><dt>${esc(t('item.toolTier'))}</dt><dd>${nf(i.tool.tier)}</dd></div>
            <div><dt>${esc(t('item.toolDamage'))}</dt><dd>${nf(i.tool.damage)}</dd></div>` : ''}
        </dl>
      </section>` : ''}

      ${recipes.length ? `<section class="panel">
        <h3>${esc(t('item.crafting'))}</h3>
        ${recipes.map(recipePanelBody).join('<hr style="border:0;border-top:1px solid var(--line-soft);margin:12px 0">')}
      </section>` : ''}

      ${set ? `<section class="panel">
        <h3>${esc(t('item.set', { name: set.name }))}</h3>
        <ul class="ingredients">
          ${set.pieces.map((p) => `<li>${pieceRow(p)}</li>`).join('')}
          ${set.associatedWeapon ? `<li>${pieceRow(set.associatedWeapon)}</li>` : ''}
        </ul>
        <h3 style="margin-top:14px">${esc(t('item.setBonus'))}</h3>
        <dl class="stats">${set.bonuses.map((b) => `<div><dt>${esc(lb('stat', b.stat))}</dt><dd>+${nf(b.value)}${b.unit === '%' ? '%' : ''}</dd></div>`).join('')}</dl>
      </section>` : ''}

      ${usedIn.length ? `<section class="panel">
        <h3>${esc(tn('item.usedIn', usedIn.length))}</h3>
        <ul class="ingredients">${usedIn.map((r) => {
          const amount = r.ingredients.find((x) => x.item === i.key)?.amount ?? 0;
          const out = IX.item.get(r.output);
          return `<li>${out?.icon ? iconImg(out.icon) : ''}
            <a href="#/recipe/${slug(r.id)}">${esc(r.outputName)}</a>
            <span class="amount">×${nf(amount)}</span></li>`;
        }).join('')}</ul>
      </section>` : ''}
    </div>

    <h2>${esc(t('item.whereDrops'))}</h2>
    <div id="drops"></div>
  </div>`);

  const dropsHost = frag.getElementById('drops');
  if (!drops.length) {
    dropsHost.append(el(`<p class="empty-note">${esc(t('item.noDrops'))}</p>`));
  } else {
    dropsHost.append(sortableTable([
      { label: t('col.source'), render: (d) => `<span class="with-icon">${iconImg(d.icon)}${
        d.monster ? `<a href="#/monster/${slug(d.monster)}">${esc(d.source)}</a>` : `<a href="#/loot/${slug(d.table)}">${esc(d.source)}</a>`}</span>` },
      { label: t('col.kind'), render: (d) => `<span class="badge">${esc(lb('kind', d.kind))}</span>` },
      { label: t('col.biome'), render: (d) => biomeBadges(d.biomes) },
      { label: lb('difficulty', 'Normal'), num: true, render: (d) => chanceCell(d.chance.normal) },
      { label: lb('difficulty', 'Hard'), num: true, render: (d) => chanceCell(d.chance.hard) },
      { label: lb('difficulty', 'Master'), num: true, render: (d) => chanceCell(d.chance.master) },
      { label: t('col.amount'), num: true, render: (d) => esc(amountsText(d.amounts)) },
    ], drops, null, 'asc', () => {}));
  }
  return frag;
}

const pieceRow = (key) => {
  const p = IX.item.get(key);
  if (!p) return esc(key);
  return `${iconImg(p.icon)}<a href="#/item/${slug(key)}">${esc(p.name)}</a>
    <span class="amount">${esc(p.slot ? lb('slot', p.slot) : lb('category', p.category))}</span>`;
};

function recipePanelBody(r) {
  return `<ul class="ingredients">${r.ingredients.map((ing) => {
    const it = IX.item.get(ing.item);
    return `<li>${it?.icon ? iconImg(it.icon) : ''}${linkItem(ing.item)}<span class="amount">×${nf(ing.amount)}</span></li>`;
  }).join('')}</ul>
  <dl class="stats" style="margin-top:11px">
    <div><dt>${esc(t('col.station'))}</dt><dd>${esc(stationText(r))}</dd></div>
    <div><dt>${esc(t('recipe.output'))}</dt><dd>×${nf(r.outputAmount)}</dd></div>
  </dl>
  <p style="margin:9px 0 0"><a href="#/recipe/${slug(r.id)}">${esc(t('recipe.openRecipe'))}</a></p>`;
}

function renderMonsterDetail(key) {
  const m = IX.monster.get(key);
  if (!m) return notFound('monster', key);

  const table = m.lootTable ? IX.loot.get(m.lootTable) : null;
  const maxHp = Math.max(...DB.monsters.map((x) => x.stats.health ?? 0));
  const maxAtk = Math.max(...DB.monsters.map((x) => x.stats.attack ?? 0));
  const maxDef = Math.max(...DB.monsters.map((x) => x.stats.defense ?? 0));

  const bar = (label, value, max) => `<div><dt>${esc(label)}</dt><dd>${nf(value)}</dd></div>
    <div class="bar" style="grid-column:1/-1"><i style="width:${max ? Math.round((value / max) * 100) : 0}%"></i></div>`;

  const frag = el(`<div>
    <p class="crumbs"><a href="#/monsters">${esc(t('monsters.title'))}</a> <span class="arrow">/</span> ${esc(lb('element', m.element))}</p>

    <div class="detail-head">
      ${thumb(m.icon, m.name)}
      <div>
        <h1>${esc(m.name)}</h1>
        <div class="detail-meta">
          ${rarityBadge(m.rarity, 'monster')}
          ${elementBadge(m.element, m.elementIcon)}
          ${m.environment ? `<span class="badge">${esc(lb('biome', m.environment))}</span>` : ''}
          <span class="badge">${esc(t(m.obtainable ? 'monster.obtainable' : 'monster.notObtainable'))}</span>
        </div>
      </div>
    </div>

    <div class="panels">
      <section class="panel">
        <h3>${esc(t('monster.baseStats'))}</h3>
        <dl class="stats">
          ${bar(t('sort.health'), m.stats.health, maxHp)}
          ${bar(t('sort.attack'), m.stats.attack, maxAtk)}
          ${bar(t('sort.defense'), m.stats.defense, maxDef)}
          <div><dt>${esc(t('monster.attackSpeed'))}</dt><dd>${m.stats.attackSpeed == null ? '—' : round(m.stats.attackSpeed).toFixed(2)}</dd></div>
          <div><dt>${esc(t('monster.attackInterval'))}</dt><dd>${m.stats.attackInterval == null ? '—' : `${round(m.stats.attackInterval).toFixed(2)}s`}</dd></div>
          ${m.stats.weightedStats ? `<div><dt>${esc(t('monster.statWeight'))}</dt><dd>${nf(m.stats.weightedStats)}</dd></div>` : ''}
        </dl>
      </section>

      ${summonPanel(m)}

      ${m.skills.length ? `<section class="panel">
        <h3>${esc(t('monster.skills'))}</h3>
        ${m.skills.map((s) => `<div class="skill">
          <div class="skill-head">
            <span class="skill-icon">${iconImg(s.icon)}</span>
            <span><span class="skill-name">${esc(s.name)}</span><span class="skill-kind ${cls(s.kind)}">${esc(s.kind)}</span></span>
          </div>
          ${s.description ? `<p>${esc(plain(s.description))}</p>` : ''}
        </div>`).join('')}
      </section>` : ''}
    </div>

    <h2>${esc(t('monster.loot'))}</h2>
    <div id="loot"></div>
  </div>`);

  const host = frag.getElementById('loot');
  if (!table?.entries.length) {
    host.append(el(`<p class="empty-note">${esc(t('monster.noLootTable'))}</p>`));
  } else {
    host.append(lootEntriesTable(table.entries));
  }
  return frag;
}

function lootEntriesTable(entries) {
  return sortableTable([
    { label: t('col.item'), render: (e) => {
      const it = IX.item.get(e.item);
      return `<span class="with-icon">${it?.icon ? iconImg(it.icon) : ''}${linkItem(e.item)}</span>`;
    } },
    { label: t('col.rarity'), render: (e) => { const it = IX.item.get(e.item); return it ? rarityBadge(it.rarity) : '—'; } },
    { label: lb('difficulty', 'Normal'), num: true, render: (e) => chanceCell(e.chance.normal) },
    { label: lb('difficulty', 'Hard'), num: true, render: (e) => chanceCell(e.chance.hard) },
    { label: lb('difficulty', 'Master'), num: true, render: (e) => chanceCell(e.chance.master) },
    { label: t('col.amount'), num: true, render: (e) => esc(amountsText(e.amounts)) },
  ], entries.slice().sort((a, b) => (b.chance.normal ?? 0) - (a.chance.normal ?? 0)), null, 'asc', () => {});
}

function renderLootList(params) {
  const kind = params.get('kind') ?? 'all';
  const biome = params.get('biome') ?? 'all';
  const itemQuery = params.get('item') ?? '';
  const needle = itemQuery.trim().toLowerCase();

  let rows = DB.loot;
  if (kind !== 'all') rows = rows.filter((t) => t.kind === kind);
  if (biome !== 'all') rows = rows.filter((t) => t.biomes.includes(biome));
  if (needle) {
    rows = rows.filter((t) => t.entries.some((e) => {
      const item = IX.item.get(e.item);
      return (item?.name ?? e.itemName ?? '').toLowerCase().includes(needle)
        || String(e.item ?? '').toLowerCase().includes(needle);
    }));
  }

  const kinds = [...new Set(DB.loot.map((t) => t.kind))].sort();
  const biomes = [...new Set(DB.loot.flatMap((t) => t.biomes))].sort();
  const matchedItems = needle ? countMatchedDrops(rows, needle) : 0;

  const frag = el(`<div>
    <h1>${esc(t('loot.title'))}</h1>
    <p class="subtitle">${esc(t('loot.subtitle', { n: nf(DB.loot.length) }))}</p>
    <div class="filters">
      <div class="filter-group" style="flex:1 1 220px">
        <span>${esc(t('loot.dropsItem'))}</span>
        <input id="loot-item" type="search" class="chip" style="flex:1;min-width:150px"
               placeholder="${esc(t('loot.placeholder'))}" value="${esc(itemQuery)}" aria-label="${esc(t('loot.filterLabel'))}">
      </div>
      ${chipGroup(t('filter.kind'), 'kind', kinds, kind, labelsFor('kind', kinds))}
      ${chipGroup(t('filter.biome'), 'biome', biomes, biome, labelsFor('biome', biomes))}
      <span class="count">${esc(tn('loot.tables', rows.length))}${needle ? ` · ${esc(tn('loot.matching', matchedItems))}` : ''}</span>
    </div>
    <div id="table"></div>
    ${rows.length ? '' : `<p class="empty-note">${esc(t('loot.empty'))}</p>`}
  </div>`);

  frag.getElementById('table').append(sortableTable([
    { label: t('col.source'), sort: 'name', value: (r) => r.sourceName, render: (r) => `<span class="with-icon">${
      r.icon ? iconImg(r.icon) : ''}<a href="#/loot/${slug(r.id)}">${esc(r.sourceName)}</a></span>` },
    { label: t('col.kind'), sort: 'kind', value: (r) => r.kind, render: (r) => `<span class="badge">${esc(lb('kind', r.kind))}</span>` },
    { label: t('col.biome'), sort: 'biome', value: (r) => r.biomes.join(', '), render: (r) => biomeBadges(r.biomes) },
    { label: t('col.entries'), num: true, sort: 'entries', value: (r) => r.entries.length, render: (r) => nf(r.entries.length) },
    // With an item filter active, show only the drops that matched.
    { label: t('col.items'), render: (r) => {
      const shown = needle
        ? r.entries.filter((e) => matchesItem(e, needle))
        : r.entries;
      const head = shown.slice(0, 4).map((e) => `${linkItem(e.item)}${
        e.chance.normal == null ? '' : ` <span class="chance">${e.chance.normal}%</span>`}`).join(', ');
      return head + (shown.length > 4 ? ` +${shown.length - 4}` : '');
    } },
  ], rows, params.get('sort') ?? 'name', params.get('dir') ?? 'asc', (key) => {
    const { parts, params: p } = parseHash();
    p.set('sort', key);
    p.set('dir', key === (params.get('sort') ?? 'name') && (params.get('dir') ?? 'asc') === 'asc' ? 'desc' : 'asc');
    location.hash = `/${parts.join('/')}?${p}`;
  }));

  wireFilters(frag);
  wireLootItemFilter(frag);
  return frag;
}

const matchesItem = (entry, needle) => {
  const item = IX.item.get(entry.item);
  return (item?.name ?? entry.itemName ?? '').toLowerCase().includes(needle)
    || String(entry.item ?? '').toLowerCase().includes(needle);
};

const countMatchedDrops = (rows, needle) =>
  rows.reduce((n, t) => n + t.entries.filter((e) => matchesItem(e, needle)).length, 0);

/** Set while the user is typing, so the caret survives the re-render. */
let refocusLootFilter = false;

/** Debounced so typing does not push a hash entry per keystroke. */
function wireLootItemFilter(root) {
  const input = root.getElementById('loot-item');
  if (!input) return;

  let timer;
  const commit = () => { refocusLootFilter = true; setParam('item', input.value.trim()); };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(commit, 220); });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { clearTimeout(timer); commit(); } });

  if (refocusLootFilter) {
    refocusLootFilter = false;
    // Deferred: the node is not in the document until route() swaps it in.
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }
}

function renderLootDetail(id) {
  const table = IX.loot.get(id);
  if (!table) return notFound('lootTable', id);
  const monster = table.monster ? IX.monster.get(table.monster) : null;

  const frag = el(`<div>
    <p class="crumbs"><a href="#/loot">${esc(t('loot.title'))}</a> <span class="arrow">/</span> ${esc(lb('kind', table.kind))}</p>
    <div class="detail-head">
      ${thumb(table.icon, table.sourceName)}
      <div>
        <h1>${esc(table.sourceName)}</h1>
        <div class="detail-meta">
          <span class="badge">${esc(lb('kind', table.kind))}</span>
          ${table.biomes.map((b) => `<span class="badge">${esc(lb('biome', b))}</span>`).join('')}
          <span class="badge">${esc(tn('loot.entries', table.entries.length))}</span>
        </div>
        ${monster ? `<p style="margin:9px 0 0"><a href="#/monster/${slug(monster.key)}">${esc(t('loot.openMonster'))}</a></p>` : ''}
      </div>
    </div>
    <div id="table" style="margin-top:20px"></div>
    ${table.spawns.length ? `<h2>${esc(t('loot.whereSpawns'))}</h2><div id="spawns"></div>` : ''}
  </div>`);

  const host = frag.getElementById('table');
  if (!table.entries.length) host.append(el(`<p class="empty-note">${esc(t('loot.tableEmpty'))}</p>`));
  else host.append(lootEntriesTable(table.entries));

  const spawnHost = frag.getElementById('spawns');
  if (spawnHost) {
    spawnHost.append(sortableTable([
      { label: t('col.biome'), render: (row) => `<span class="badge">${esc(lb('biome', row.biome))}</span>` },
      { label: t('col.difficulty'), render: (row) => esc(lb('difficulty', row.difficulty)) },
      { label: t('col.prop'), render: (row) => esc(prettifyName(row.resource)) },
      { label: t('col.spawnChance'), num: true, render: (row) => chanceCell(row.spawnChance) },
    ], table.spawns, null, 'asc', () => {}));
  }
  return frag;
}

/**
 * Which permanent banners carry the monster, and from which rarity pool — never
 * the odds, which are retuned constantly and already shown in the client. Limited
 * event banners are left out of the payload entirely.
 */
function summonPanel(m) {
  if (!m.summon.length) {
    return `<section class="panel"><h3>${esc(t('monster.howToObtain'))}</h3>
      <p class="empty-note">${esc(t('monster.noSummon'))}</p>
    </section>`;
  }

  const pools = [...new Set(m.summon.map((s) => s.poolRarity))].map((r) => lb('rarity', r));

  return `<section class="panel">
    <h3>${esc(t('monster.howToObtain'))}</h3>
    <p class="empty-note" style="margin-bottom:11px">
      ${esc(t('monster.summonedFrom', { pools: pools.join(' / ') }))}
    </p>
    <ul class="pill-list">${m.summon.map((s) => `<li><span class="badge">${esc(s.bannerName)}</span></li>`).join('')}</ul>
  </section>`;
}

/** Turns authoring names into labels: `SwampTree`, `rare_pool` -> `Swamp Tree`, `Rare Pool`. */
const prettifyName = (s) => String(s ?? '')
  .replace(/[_-]+/g, ' ')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());

function renderRecipes(params) {
  const category = params.get('category') ?? 'all';
  const station = params.get('station') ?? 'all';

  let rows = DB.recipes;
  if (category !== 'all') rows = rows.filter((r) => r.category === category);
  if (station !== 'all') rows = rows.filter((r) => r.station === station);

  const categories = [...new Set(DB.recipes.map((r) => r.category))].sort();
  const stations = [...new Set(DB.recipes.map((r) => r.station))].sort();

  const frag = el(`<div>
    <h1>${esc(t('recipes.title'))}</h1>
    <p class="subtitle">${esc(t('recipes.subtitle', { n: nf(DB.recipes.length) }))}</p>
    <div class="filters">
      ${chipGroup(t('filter.category'), 'category', categories, category, labelsFor('category', categories))}
      ${chipGroup(t('filter.station'), 'station', stations, station, labelsFor('station', stations))}
      <span class="count">${esc(t('filter.shown', { n: nf(rows.length) }))}</span>
    </div>
    <div id="table"></div>
  </div>`);

  frag.getElementById('table').append(sortableTable([
    { label: t('col.result'), sort: 'name', value: (r) => r.outputName, render: (r) => {
      const it = IX.item.get(r.output);
      return `<span class="with-icon">${it?.icon ? iconImg(it.icon) : ''}<a href="#/recipe/${slug(r.id)}">${esc(r.outputName)}</a>${r.outputAmount > 1 ? ` ×${r.outputAmount}` : ''}</span>`;
    } },
    { label: t('col.category'), sort: 'category', value: (r) => r.category, render: (r) => `<span class="badge">${esc(lb('category', r.category))}</span>` },
    { label: t('col.station'), sort: 'station', value: (r) => r.station, render: (r) => esc(lb('station', r.station)) },
    { label: t('col.level'), num: true, sort: 'level', value: (r) => r.stationLevel, render: (r) => nf(r.stationLevel) },
    { label: t('col.ingredients'), render: (r) => r.ingredients.map((ing) => `${linkItem(ing.item)} ×${nf(ing.amount)}`).join(', ') },
  ], rows, params.get('sort') ?? 'name', params.get('dir') ?? 'asc', (key) => {
    const { parts, params: p } = parseHash();
    p.set('sort', key);
    p.set('dir', key === (params.get('sort') ?? 'name') && (params.get('dir') ?? 'asc') === 'asc' ? 'desc' : 'asc');
    location.hash = `/${parts.join('/')}?${p}`;
  }));
  wireFilters(frag);
  return frag;
}

function renderRecipeDetail(id) {
  const r = IX.recipe.get(id);
  if (!r) return notFound('recipe', id);
  const out = IX.item.get(r.output);

  return el(`<div>
    <p class="crumbs"><a href="#/recipes">${esc(t('recipes.title'))}</a> <span class="arrow">/</span> ${esc(lb('category', r.category))}</p>
    <div class="detail-head">
      ${thumb(out?.icon, r.outputName)}
      <div>
        <h1>${esc(r.outputName)}${r.outputAmount > 1 ? ` ×${r.outputAmount}` : ''}</h1>
        <div class="detail-meta">
          ${out ? rarityBadge(out.rarity) : ''}
          <span class="badge">${esc(lb('category', r.category))}</span>
          <span class="badge">${esc(stationText(r))}</span>
        </div>
        ${out ? `<p style="margin:9px 0 0"><a href="#/item/${slug(out.key)}">${esc(t('recipe.openItem'))}</a></p>` : ''}
      </div>
    </div>

    <div class="panels" style="margin-top:20px">
      <section class="panel">
        <h3>${esc(t('col.ingredients'))}</h3>
        <ul class="ingredients">${r.ingredients.map((ing) => {
          const it = IX.item.get(ing.item);
          return `<li>${it?.icon ? iconImg(it.icon) : ''}${linkItem(ing.item)}<span class="amount">×${nf(ing.amount)}</span></li>`;
        }).join('')}</ul>
      </section>
      ${subRecipesPanel(r)}
    </div>
  </div>`);
}

/** Ingredients that are themselves craftable, so the chain is visible. */
function subRecipesPanel(r) {
  const subs = r.ingredients
    .map((ing) => IX.item.get(ing.item))
    .filter((it) => it?.craftedBy.length)
    .map((it) => IX.recipe.get(it.craftedBy[0]))
    .filter(Boolean);
  if (!subs.length) return '';

  return `<section class="panel">
    <h3>${esc(t('recipe.subParts'))}</h3>
    ${subs.map((s) => `<div class="skill">
      <span class="skill-name"><a href="#/recipe/${slug(s.id)}">${esc(s.outputName)}</a></span>
      <span class="skill-kind">${esc(stationText(s))}</span>
      <p>${s.ingredients.map((ing) => `${esc(ing.itemName)} ×${nf(ing.amount)}`).join(' · ')}</p>
    </div>`).join('')}
  </section>`;
}

function renderSets() {
  const frag = el(`<div>
    <h1>${esc(t('sets.title'))}</h1>
    <p class="subtitle">${esc(t('sets.subtitle', { n: nf(DB.sets.length) }))}</p>
    <div class="panels" id="list"></div>
  </div>`);

  frag.getElementById('list').append(...DB.sets.map((s) => el(`<section class="panel">
    <h3>${esc(s.name)}</h3>
    <ul class="ingredients">
      ${s.pieces.map((p) => `<li>${pieceRow(p)}</li>`).join('')}
      ${s.associatedWeapon ? `<li>${pieceRow(s.associatedWeapon)}</li>` : ''}
    </ul>
    <h3 style="margin-top:14px">${esc(t('item.setBonus'))}</h3>
    <dl class="stats">${s.bonuses.map((b) => `<div><dt>${esc(lb('stat', b.stat))}</dt><dd>+${nf(b.value)}${b.unit === '%' ? '%' : ''}</dd></div>`).join('')}</dl>
  </section>`)));
  return frag;
}

/* ---------------------------------------------------------------- buildings */

const duration = (seconds) => {
  if (!seconds) return t('building.instant');
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(' ');
};

const costText = (c) => {
  const parts = [];
  if (c.amount) parts.push(`${nf(c.amount)} ${lb('currency', c.currency)}`);
  for (const m of c.materials) parts.push(`${esc(m.itemName)} ×${nf(m.amount)}`);
  return parts.length ? parts.join(' · ') : t('building.free');
};

function renderBuildings(params) {
  const category = params.get('category') ?? 'all';
  let rows = DB.buildings;
  if (category !== 'all') rows = rows.filter((b) => b.category === category);

  const categories = [...new Set(DB.buildings.map((b) => b.category))].sort();

  const frag = el(`<div>
    <h1>${esc(t('buildings.title'))}</h1>
    <p class="subtitle">${esc(t('buildings.subtitle', { n: nf(DB.buildings.length) }))}</p>
    <div class="filters">
      ${chipGroup(t('filter.category'), 'category', categories, category, labelsFor('buildingCategory', categories))}
      <span class="count">${esc(t('filter.shown', { n: nf(rows.length) }))}</span>
    </div>
    <div class="panels" id="list"></div>
  </div>`);

  frag.getElementById('list').append(...rows.map((b) => el(`<section class="panel">
    <div class="skill-head" style="margin-bottom:10px">
      <span class="thumb" style="width:44px;height:44px;flex:none">${iconImg(b.icon, b.name)}</span>
      <span>
        <span class="skill-name" style="font-size:16px">${esc(b.name)}</span>
        <span class="skill-kind">${esc(lb('buildingCategory', b.category))}</span>
      </span>
    </div>
    ${b.description ? `<p style="margin:0 0 12px;font-size:13px;color:var(--text-dim)">${esc(plain(b.description))}</p>` : ''}
    <dl class="stats">
      <div><dt>${esc(t('building.buy'))}</dt><dd>${costText(b.purchase)}</dd></div>
      ${b.purchase.buildSeconds ? `<div><dt>${esc(t('building.buildTime'))}</dt><dd>${esc(duration(b.purchase.buildSeconds))}</dd></div>` : ''}
      <div><dt>${esc(t('building.maxLevel'))}</dt><dd>${nf(b.maxLevel)}</dd></div>
    </dl>
    ${b.upgrades.length ? `<h3 style="margin:14px 0 8px">${esc(t('building.upgrades'))}</h3>
      <div class="table-wrap"><table><thead><tr><th>${esc(t('col.level'))}</th><th>${esc(t('col.cost'))}</th><th>${esc(t('col.time'))}</th></tr></thead><tbody>
        ${b.upgrades.map((u) => `<tr><td>${u.level}</td><td>${costText(u)}</td><td>${esc(duration(u.buildSeconds))}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
  </section>`)));

  wireFilters(frag);
  return frag;
}

/* ----------------------------------------------------------- status effects */

const statusCard = (s) => el(`<section class="status s-${cls(s.group)}">
  <span class="thumb status-icon">${iconImg(s.icon, s.name)}</span>
  <div class="status-body">
    <span class="status-name">${esc(s.name)}${s.tickSeconds ? `<span class="skill-kind">${esc(t('status.every', { n: s.tickSeconds }))}</span>` : ''}</span>
    ${s.effects.length
    ? `<ul class="status-effects">${s.effects.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
    : `<p class="status-none">${esc(t('status.noDescription'))}</p>`}
  </div>
</section>`);

function renderStatuses(params) {
  const group = params.get('group') ?? 'all';
  const groups = [...new Set(DB.statuses.map((s) => s.group))];
  const shown = group === 'all' ? groups : groups.filter((g) => g === group);

  const frag = el(`<div>
    <h1>${esc(t('status.title'))}</h1>
    <p class="subtitle">${esc(t('status.subtitle', {
    n: nf(DB.statuses.length),
    buffs: nf(DB.statuses.filter((s) => s.group === 'Buff').length),
    debuffs: nf(DB.statuses.filter((s) => s.group === 'Debuff').length),
  }))}</p>
    <div class="filters">
      ${chipGroup(t('filter.group'), 'group', groups, group, labelsFor('group', groups))}
    </div>
    <div id="list"></div>
  </div>`);

  frag.getElementById('list').append(...shown.map((g) => {
    const section = el(`<section>
      <h2 class="status-group ${cls(g)}">${esc(g === 'Buff' ? t('status.buffs') : g === 'Debuff' ? t('status.debuffs') : lb('group', g))}</h2>
      <div class="status-grid"></div>
    </section>`);
    section.querySelector('.status-grid').append(...DB.statuses.filter((s) => s.group === g).map(statusCard));
    return section;
  }));

  wireFilters(frag);
  return frag;
}

/* ------------------------------------------------------------------ talents */

function renderTalents() {
  // The odds come from the title data the game uploads; without them the table
  // simply drops the column rather than showing a blank one.
  const hasOdds = DB.talents.some((talent) => talent.levels.some((l) => l.chance != null));

  const frag = el(`<div>
    <h1>${esc(t('talents.title'))}</h1>
    <p class="subtitle">${esc(t('talents.subtitle', { n: nf(DB.talents.length) }))}</p>
    ${hasOdds ? `<p class="empty-note">${esc(t('talents.oddsNote', {
    n: nf(DB.talents.length),
    pct: round(100 / DB.talents.length, 1),
  }))}</p>` : ''}
    <div class="panels" id="list"></div>
  </div>`);

  frag.getElementById('list').append(...DB.talents.map((talent) => el(`<section class="panel">
    <div class="skill-head" style="margin-bottom:10px">
      <span class="thumb" style="width:44px;height:44px;flex:none">${iconImg(talent.icon, talent.name)}</span>
      <span>
        <span class="skill-name" style="font-size:16px">${esc(talent.name)}</span>
        <span class="skill-kind">${esc(t('talents.ranks', { n: nf(talent.maxLevel) }))}</span>
      </span>
    </div>
    <div class="table-wrap"><table><thead><tr>
      <th>${esc(t('col.rank'))}</th>
      ${hasOdds ? `<th class="num">${esc(t('col.chance'))}</th>` : ''}
      <th>${esc(t('col.effect'))}</th>
    </tr></thead><tbody>
      ${talent.levels.map((l) => `<tr>
        <td class="rank">${esc(l.roman)}</td>
        ${hasOdds ? `<td class="num">${l.chance == null ? '—' : chanceCell(l.chance)}</td>` : ''}
        <td>${esc(l.description ?? '—')}</td>
      </tr>`).join('')}
    </tbody></table></div>
  </section>`)));

  return frag;
}

/* ------------------------------------------------------------------- combat */

const DEFENSE_MAX = 8000;
const DEFENSE_SAMPLES = [0, 200, 400, 800, 1600, 3000, 5000, 8000];

/** Chart geometry, in viewBox units. */
const CURVE = { w: 1000, h: 300, left: 54, right: 16, top: 14, bottom: 28 };
const curveX = (defense) => CURVE.left + (defense / DEFENSE_MAX) * (CURVE.w - CURVE.left - CURVE.right);
const curveY = (share) => CURVE.h - CURVE.bottom - share * (CURVE.h - CURVE.top - CURVE.bottom);

/** The share of an ordinary hit that Defense removes, straight from the sim. */
const negatedShare = (defense, reference) => (reference + defense <= 0 ? 0 : defense / (reference + defense));

/**
 * The mitigation curve, drawn once. Its shape is the whole point: the climb is
 * steep at first and never reaches the top, which a row of numbers hides.
 */
function defenseCurve(ref) {
  const points = [];
  for (let d = 0; d <= DEFENSE_MAX; d += DEFENSE_MAX / 200) {
    points.push(`${d === 0 ? 'M' : 'L'}${curveX(d).toFixed(1)} ${curveY(negatedShare(d, ref)).toFixed(1)}`);
  }

  const grid = [0, 0.25, 0.5, 0.75, 1].map((share) => `
    <line class="curve-grid" x1="${CURVE.left}" y1="${curveY(share)}" x2="${CURVE.w - CURVE.right}" y2="${curveY(share)}"/>
    <text class="curve-label" x="${CURVE.left - 8}" y="${curveY(share) + 4}" text-anchor="end">${share * 100}%</text>`).join('');

  const ticks = [0, 2000, 4000, 6000, 8000].map((d) => `
    <text class="curve-label" x="${curveX(d)}" y="${CURVE.h - 8}" text-anchor="middle">${d / 1000 ? `${d / 1000}k` : '0'}</text>`).join('');

  return `<svg class="curve" viewBox="0 0 ${CURVE.w} ${CURVE.h}" role="img" aria-label="${esc(t('combat.curve'))}">
    ${grid}${ticks}
    <path class="curve-line" d="${points.join(' ')}"/>
    <line id="curve-drop" class="curve-guide" x1="0" y1="0" x2="0" y2="0"/>
    <line id="curve-reach" class="curve-guide" x1="0" y1="0" x2="0" y2="0"/>
    <circle id="curve-dot" class="curve-dot" cx="0" cy="0" r="8"/>
  </svg>`;
}

/** `max(Resistance − Accuracy, floor)` — nothing is ever fully reliable. */
const resistShare = (resistance, accuracy, floor) => Math.max(resistance - accuracy, floor);

const setLine = (line, x1, y1, x2, y2) => {
  line.setAttribute('x1', x1); line.setAttribute('y1', y1);
  line.setAttribute('x2', x2); line.setAttribute('y2', y2);
};

const pct = (share, digits = 1) => `${(share * 100).toFixed(digits)}%`;

function renderCombat() {
  const c = DB.meta?.combat;
  if (!c) return el(`<div><h1>${esc(t('combat.title'))}</h1><p class="empty-note">${esc(t('combat.empty'))}</p></div>`);

  const ref = c.defenseReference;

  const frag = el(`<div>
    <h1>${esc(t('combat.title'))}</h1>
    <p class="subtitle">${esc(t('combat.subtitle'))}</p>

    <h2>${esc(t('combat.defense'))}</h2>
    <p class="empty-note">${esc(c.usesFixedReference
    ? t('combat.defenseNote', { ref: nf(ref) })
    : t('combat.defenseNoteAttack'))}</p>

    <section class="panel calc">
      <label class="calc-row">
        <span>${esc(lb('stat', 'Defense'))}</span>
        <input id="def" type="range" min="0" max="${DEFENSE_MAX}" step="10" value="400">
        <output id="def-out" class="calc-value">400</output>
      </label>
      <label class="calc-row">
        <span>${esc(t('combat.incoming'))}</span>
        <input id="hit" type="range" min="50" max="5000" step="50" value="1000">
        <output id="hit-out" class="calc-value">1 000</output>
      </label>
      <div class="curve-wrap">${defenseCurve(ref)}</div>
      <p class="curve-hint">${esc(t('combat.curveHint'))}</p>
      <div class="calc-result">
        <div><b id="negated">—</b><span>${esc(t('combat.negated'))}</span></div>
        <div><b id="through">—</b><span>${esc(t('combat.through'))}</span></div>
      </div>
      <p class="calc-formula"><code id="def-formula"></code></p>
    </section>

    <div class="table-wrap"><table>
      <thead><tr><th class="num">${esc(lb('stat', 'Defense'))}</th><th class="num">${esc(t('combat.negated'))}</th></tr></thead>
      <tbody>${DEFENSE_SAMPLES.map((d) => `<tr><td class="num">${nf(d)}</td><td class="num">${pct(negatedShare(d, ref))}</td></tr>`).join('')}</tbody>
    </table></div>

    <ul class="status-effects combat-notes">
      <li>${esc(t('combat.noteDiminishing'))}</li>
      <li>${esc(t('combat.noteDot'))}</li>
      ${c.damageScale && c.damageScale !== 1 ? `<li>${esc(t('combat.noteScale', { n: c.damageScale }))}</li>` : ''}
      <li>${esc(t('combat.noteReduction', { stat: lb('stat', 'Damage Reduction') }))}</li>
      ${c.elementStrong && c.elementWeak ? `<li>${esc(t('combat.noteElement', {
    strong: pct(c.elementStrong - 1, 0), weak: pct(1 - c.elementWeak, 0), crit: pct(c.elementCritShift, 0),
  }))}</li>` : ''}
    </ul>

    <h2>${esc(t('combat.resist'))}</h2>
    <p class="empty-note">${esc(t('combat.resistNote', { floor: pct(c.resistFloor, 0) }))}</p>

    <section class="panel calc">
      <label class="calc-row">
        <span>${esc(lb('stat', 'Resistance'))}</span>
        <input id="res" type="range" min="0" max="100" step="1" value="30">
        <output id="res-out" class="calc-value">30%</output>
      </label>
      <label class="calc-row">
        <span>${esc(lb('stat', 'Accuracy'))}</span>
        <input id="acc" type="range" min="0" max="100" step="1" value="10">
        <output id="acc-out" class="calc-value">10%</output>
      </label>
      ${c.elementAccuracyShift ? `<div class="filter-group calc-row">
        <span>${esc(t('combat.matchup'))}</span>
        ${[['1', t('combat.matchupStrong')], ['0', t('combat.matchupNeutral')], ['-1', t('combat.matchupWeak')]]
    .map(([v, label]) => `<button type="button" class="chip matchup" data-v="${v}"
             aria-pressed="${v === '0'}">${esc(label)}</button>`).join('')}
      </div>` : ''}
      <div class="calc-result">
        <div><b id="resisted">—</b><span>${esc(t('combat.resisted'))}</span></div>
        <div><b id="lands">—</b><span>${esc(t('combat.lands'))}</span></div>
      </div>
      <p class="calc-formula"><code id="res-formula"></code></p>
    </section>

    <h3>${esc(t('combat.whatResists'))}</h3>
    <ul class="status-effects combat-notes">
      <li>${esc(t('combat.resistDebuffsOnly', { debuffs: lb('group', 'Debuff'), buffs: lb('group', 'Buff') }))}</li>
      <li>${esc(t('combat.resistImmunity'))}</li>
      <li>${esc(t('combat.resistMalediction'))}</li>
      <li>${esc(t('combat.resistForced'))}</li>
      ${c.statusSlots ? `<li>${esc(t('combat.resistSlots', { n: c.statusSlots }))}</li>` : ''}
    </ul>
  </div>`);

  wireCombat(frag, c);
  return frag;
}

/**
 * Both calculators are plain range inputs recomputed on every move. No state
 * outside the page: a reader can leave and come back without carrying anything.
 *
 * Every element is looked up once, up front. `route()` moves the fragment's
 * children into the document, which leaves the fragment empty — so a handler that
 * called `root.getElementById` later would find nothing and throw.
 */
function wireCombat(root, c) {
  const el = {};
  for (const id of ['def', 'hit', 'def-out', 'hit-out', 'negated', 'through', 'def-formula',
    'curve-dot', 'curve-drop', 'curve-reach',
    'res', 'acc', 'res-out', 'acc-out', 'resisted', 'lands', 'res-formula']) {
    el[id] = root.getElementById(id);
  }
  const matchups = [...root.querySelectorAll('.matchup')];
  const ref = c.defenseReference;

  const refreshDefense = () => {
    const d = Number(el.def.value);
    const raw = Number(el.hit.value);
    const share = negatedShare(d, ref);
    el['def-out'].textContent = nf(d);
    el['hit-out'].textContent = nf(raw);
    el.negated.textContent = pct(share);
    // The simulation floors an ordinary hit at 1, so the wiki does too.
    el.through.textContent = nf(Math.max(1, Math.round(raw * (1 - share))));
    // Ungrouped on purpose: "3.000" inside a formula reads as three wherever the
    // locale groups with a dot.
    el['def-formula'].textContent = `${ref} / (${ref} + ${d}) = ${pct(1 - share)}`;

    const x = curveX(d);
    const y = curveY(share);
    el['curve-dot'].setAttribute('cx', x);
    el['curve-dot'].setAttribute('cy', y);
    // Guides down to the axis and across to the scale, so the reading is exact
    // without hunting along the curve.
    setLine(el['curve-drop'], x, y, x, CURVE.h - CURVE.bottom);
    setLine(el['curve-reach'], CURVE.left, y, x, y);
  };
  el.def.addEventListener('input', refreshDefense);
  el.hit.addEventListener('input', refreshDefense);

  const chart = root.querySelector('.curve');
  if (chart) {
    // Pointing at the curve is quicker than dragging to a value, and dragging on
    // it keeps working because the pointer is captured.
    const pickFromChart = (event) => {
      const box = chart.getBoundingClientRect();
      const ratio = ((event.clientX - box.left) / box.width * CURVE.w - CURVE.left)
        / (CURVE.w - CURVE.left - CURVE.right);
      el.def.value = String(Math.round(Math.min(1, Math.max(0, ratio)) * DEFENSE_MAX));
      refreshDefense();
    };
    chart.addEventListener('pointerdown', (event) => {
      chart.setPointerCapture(event.pointerId);
      pickFromChart(event);
    });
    chart.addEventListener('pointermove', (event) => {
      if (chart.hasPointerCapture(event.pointerId)) pickFromChart(event);
    });
  }

  refreshDefense();

  let matchup = 0;
  const refreshResist = () => {
    const r = Number(el.res.value) / 100;
    const shift = matchup * (c.elementAccuracyShift ?? 0);
    const a = Number(el.acc.value) / 100 + shift;
    const share = resistShare(r, a, c.resistFloor);
    el['res-out'].textContent = pct(r, 0);
    el['acc-out'].textContent = pct(Number(el.acc.value) / 100, 0);
    el.resisted.textContent = pct(share, 0);
    el.lands.textContent = pct(1 - share, 0);
    // An element penalty makes accuracy negative, which would print "− -5%".
    const accuracyTerm = a < 0 ? `+ ${pct(-a, 0)}` : `− ${pct(a, 0)}`;
    el['res-formula'].textContent = r - a < c.resistFloor
      ? t('combat.resistFloored', { floor: pct(c.resistFloor, 0) })
      : `${pct(r, 0)} ${accuracyTerm} = ${pct(share, 0)}`;
  };
  el.res.addEventListener('input', refreshResist);
  el.acc.addEventListener('input', refreshResist);

  for (const button of matchups) {
    button.addEventListener('click', () => {
      matchup = Number(button.dataset.v);
      for (const other of matchups) other.setAttribute('aria-pressed', String(other === button));
      refreshResist();
    });
  }
  refreshResist();
}

/* --------------------------------------------------------------- skill tree */

/** Shapes tell the node types apart at map scale, where a label would not fit. */
const NODE_RADIUS = { Root: 54, ClassHub: 46, ActiveSkill: 32, Passive: 28, Capstone: 34, Notable: 24, Minor: 16 };

const treeClass = (key) => DB.skilltree.classes.find((c) => c.key === key) ?? null;
const treeColour = (node) => treeClass(node.classKey)?.colour ?? '#f0b32d';

/**
 * `+145 Max Health`, `+8% Crit Chance`.
 *
 * Percent grants are stored in hundredths and floored, never rounded up — the
 * simulation would not grant the extra point, so neither does the wiki.
 */
const grantText = (g) => {
  const amount = g.kind === 'Percent' ? `${Math.floor(g.value / 100)}%` : String(g.value);
  return `${g.value < 0 ? '' : '+'}${amount} ${lb('stat', g.stat)}`;
};

/** A stat node has no authored name: the game builds one from its first grant. */
const nodeTitle = (node) => {
  if (node.name) return node.name;
  const template = DB.skilltree.nameTemplates?.[node.type];
  const stat = lb('stat', node.grants[0]?.stat);
  return template ? template.replace(/\{\[NAME\]\}/g, stat) : stat;
};

const unlockText = (cost) => {
  if (!cost) return null;
  const parts = [];
  if (cost.coins) parts.push(`${nf(cost.coins)} ${lb('currency', 'Coin')}`);
  for (const m of cost.materials) parts.push(`${m.itemName} ×${nf(m.amount)}`);
  return parts.join(' · ') || null;
};

/**
 * The whole graph at its authored positions, so it reads like the tree in game.
 * Links are drawn first, so a node always sits on top of its own edges.
 */
function treeMap(shownNodes) {
  const b = DB.skilltree.bounds;
  const pad = 80;
  const width = (b.maxX - b.minX) + pad * 2;
  const height = (b.maxY - b.minY) + pad * 2;
  const px = (n) => n.x - b.minX + pad;
  // Authored Y grows upward; SVG's grows downward.
  const py = (n) => b.maxY - n.y + pad;

  const byId = new Map(DB.skilltree.nodes.map((n) => [n.id, n]));
  const shown = new Set(shownNodes.map((n) => n.id));

  const edges = [];
  for (const node of DB.skilltree.nodes) {
    for (const id of node.links) {
      const other = byId.get(id);
      if (!other) continue;
      const lit = shown.has(node.id) && shown.has(id);
      edges.push(`<line x1="${px(node)}" y1="${py(node)}" x2="${px(other)}" y2="${py(other)}"
        class="tree-link${lit ? ' on' : ''}"${lit ? ` stroke="${esc(treeColour(node))}"` : ''}/>`);
    }
  }

  const marks = DB.skilltree.nodes.map((node) => {
    const lit = shown.has(node.id);
    const r = NODE_RADIUS[node.type] ?? 14;
    const x = px(node);
    const y = py(node);
    // A diamond marks a notable and a square an active skill: the shape carries
    // the type where there is no room for a word.
    const shape = node.type === 'Notable'
      ? `<rect x="${x - r}" y="${y - r}" width="${r * 2}" height="${r * 2}" rx="4" transform="rotate(45 ${x} ${y})"/>`
      : node.type === 'ActiveSkill'
        ? `<rect x="${x - r}" y="${y - r}" width="${r * 2}" height="${r * 2}" rx="6"/>`
        : `<circle cx="${x}" cy="${y}" r="${r}"/>`;

    return `<g class="tree-node${lit ? ' on' : ''}" fill="${esc(lit ? treeColour(node) : 'var(--line)')}" data-node="${node.id}">
      <title>${esc(`${nodeTitle(node)} — ${lb('nodeType', node.type)}`)}</title>${shape}</g>`;
  });

  return `<div class="tree-map"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(t('tree.map'))}">
    <g class="tree-links">${edges.join('')}</g>${marks.join('')}
  </svg></div>`;
}

function treeNodeCard(node) {
  const unlock = unlockText(node.cost);
  return `<section class="panel tree-card" id="node-${node.id}" style="--node:${esc(treeColour(node))}">
    <div class="skill-head" style="margin-bottom:8px">
      <span class="thumb" style="width:40px;height:40px;flex:none">${iconImg(node.icon, nodeTitle(node))}</span>
      <span>
        <span class="skill-name" style="font-size:15px">${esc(nodeTitle(node))}</span>
        <span class="skill-kind">${esc(lb('nodeType', node.type))} · ${esc(t('tree.tier', { n: node.tier }))}</span>
      </span>
    </div>
    ${node.description ? `<p class="tree-desc">${esc(plain(node.description))}</p>` : ''}
    ${node.grants.length ? `<ul class="status-effects">${node.grants.map((g) => `<li>${esc(grantText(g))}</li>`).join('')}</ul>` : ''}
    <dl class="stats" style="margin-top:10px">
      <div><dt>${esc(t('tree.points'))}</dt><dd>${nf(node.points)}</dd></div>
      ${node.cost?.level ? `<div><dt>${esc(t('col.level'))}</dt><dd>${nf(node.cost.level)}</dd></div>` : ''}
      ${unlock ? `<div><dt>${esc(t('tree.unlock'))}</dt><dd>${esc(unlock)}</dd></div>` : ''}
    </dl>
  </section>`;
}

/** 60 near-identical stat nodes per class read better as one dense table. */
function minorTable(minors) {
  if (!minors.length) return '';
  return `<h3 class="tree-group">${esc(lb('nodeType', 'Minor'))} · ${nf(minors.length)}</h3>
    <div class="table-wrap"><table>
      <thead><tr>
        <th>${esc(t('col.effect'))}</th>
        <th class="num">${esc(t('col.tier'))}</th>
        <th class="num">${esc(t('tree.points'))}</th>
        <th>${esc(t('tree.unlock'))}</th>
      </tr></thead>
      <tbody>${minors.map((n) => `<tr id="node-${n.id}">
        <td>${n.grants.map((g) => esc(grantText(g))).join(', ') || '—'}</td>
        <td class="num">${nf(n.tier)}</td>
        <td class="num">${nf(n.points)}</td>
        <td>${esc(unlockText(n.cost) ?? '—')}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

function renderTree(params) {
  const tree = DB.skilltree;
  if (!tree?.nodes?.length) {
    return el(`<div><h1>${esc(t('tree.title'))}</h1><p class="empty-note">${esc(t('tree.empty'))}</p></div>`);
  }

  const chosen = params.get('class') ?? 'all';
  const keys = tree.classes.map((c) => c.key);
  const shown = chosen === 'all' ? tree.nodes : tree.nodes.filter((n) => n.classKey === chosen);
  const legend = ['Root', 'ClassHub', 'ActiveSkill', 'Passive', 'Notable', 'Minor'].filter((type) => tree.counts[type]);

  const frag = el(`<div>
    <h1>${esc(t('tree.title'))}</h1>
    <p class="subtitle">${esc(t('tree.subtitle', { n: nf(tree.nodes.length), classes: nf(tree.classes.length) }))}</p>

    <div class="grid" id="classes"></div>

    <h2>${esc(t('tree.map'))}</h2>
    <p class="empty-note">${esc(t('tree.mapNote'))}</p>
    <div class="filters">
      ${chipGroup(t('tree.class'), 'class', keys, chosen, Object.fromEntries(tree.classes.map((c) => [c.key, c.name])))}
    </div>
    <div id="map"></div>
    <ul class="pill-list tree-legend">${legend.map((type) => `<li><span class="badge">
      <i class="legend legend-${cls(type)}"></i>${esc(lb('nodeType', type))} · ${nf(tree.counts[type])}</span></li>`).join('')}</ul>

    <h2>${esc(t('tree.rules'))}</h2>
    <ul class="status-effects tree-rules">
      <li>${esc(t('tree.rulePrereq'))}</li>
      <li>${esc(t('tree.ruleOneClass'))}</li>
      <li>${esc(t('tree.ruleClasses', { n: nf(tree.extraClassDiamondCost) }))}</li>
      ${tree.skillSlotDiamondCosts?.length ? `<li>${esc(t('tree.ruleSlots', { costs: tree.skillSlotDiamondCosts.map(nf).join(' / ') }))}</li>` : ''}
    </ul>

    <div id="sections"></div>
  </div>`);

  frag.getElementById('classes').append(...tree.classes.map((c) => el(`<a class="card" href="#/tree?class=${slug(c.key)}" style="--node:${esc(c.colour)}">
    ${thumb(c.icon, c.name)}
    <span class="card-body">
      <span class="card-title">${esc(c.name)}</span>
      <span class="card-sub">${esc(t('tree.nodeCount', { n: nf(c.nodes) }))}</span>
    </span></a>`)));

  frag.getElementById('map').append(el(treeMap(shown)));

  const host = frag.getElementById('sections');
  for (const c of tree.classes) {
    if (chosen !== 'all' && c.key !== chosen) continue;
    const own = tree.nodes.filter((n) => n.classKey === c.key);

    host.append(el(`<section class="tree-section" style="--node:${esc(c.colour)}">
      <h2 class="tree-class-head">${iconImg(c.icon, c.name)}<span>${esc(c.name)}</span></h2>
      ${c.description ? `<p class="empty-note">${esc(plain(c.description))}</p>` : ''}
      ${['ActiveSkill', 'Passive', 'Notable'].map((type) => {
    const list = own.filter((n) => n.type === type);
    if (!list.length) return '';
    return `<h3 class="tree-group">${esc(lb('nodeType', type))} · ${nf(list.length)}</h3>
          <div class="panels">${list.map(treeNodeCard).join('')}</div>`;
  }).join('')}
      ${minorTable(own.filter((n) => n.type === 'Minor'))}
    </section>`));
  }

  wireFilters(frag);
  wireTreeMap(frag);
  return frag;
}

/** Clicking a node on the map jumps to its card or row below. */
function wireTreeMap(root) {
  root.querySelectorAll('.tree-node[data-node]').forEach((mark) => {
    mark.addEventListener('click', () => {
      const target = document.getElementById(`node-${mark.dataset.node}`);
      if (!target) return;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.remove('flash');
      // Reflow, so the highlight replays when the same node is clicked twice.
      void target.offsetWidth;
      target.classList.add('flash');
    });
  });
}

/* --------------------------------------------------------------- game modes */

const modeLevelCount = (m) => m.groups.reduce((n, g) => n + g.sets.reduce((k, s) => k + s.levels.length, 0), 0);

function renderModes() {
  const frag = el(`<div>
    <h1>${esc(t('modes.title'))}</h1>
    <p class="subtitle">${esc(t('modes.subtitle'))}</p>
    <div class="grid" id="list"></div>
  </div>`);

  frag.getElementById('list').append(...DB.gamemodes.map((m) => el(`<a class="card" href="#/mode/${slug(m.key)}">
    ${thumb(m.icon, m.name)}
    <span class="card-body">
      <span class="card-title">${esc(m.name)}</span>
      <span class="card-sub">${esc(modeSummary(m))}${m.players > 1 ? ` · ${esc(t('mode.players', { n: m.players }))}` : ''}</span>
    </span></a>`)));
  return frag;
}

/** Bastion has no levels to count — it is endless by construction. */
const modeSummary = (m) => (m.kind === 'endless'
  ? t('bastion.endless')
  : t('mode.levels', { n: nf(modeLevelCount(m)) }));

function renderMode(key) {
  const mode = IX.mode.get(key);
  if (!mode) return notFound('gameMode', key);
  if (mode.bastion) return renderBastion(mode);

  const single = mode.groups.length === 1;
  const frag = el(`<div>
    <p class="crumbs"><a href="#/modes">${esc(t('modes.title'))}</a></p>
    <div class="detail-head">
      ${thumb(mode.icon, mode.name)}
      <div>
        <h1>${esc(mode.name)}</h1>
        <div class="detail-meta">
          <span class="badge">${esc(t('mode.levels', { n: nf(modeLevelCount(mode)) }))}</span>
          ${mode.players > 1 ? `<span class="badge">${esc(t('mode.players', { n: mode.players }))}</span>` : ''}
        </div>
      </div>
    </div>
    ${mode.blurb ? `<p class="subtitle" style="margin-top:18px">${esc(mode.blurb)}</p>` : ''}
    <div class="grid" id="list"></div>
  </div>`);

  frag.getElementById('list').append(...mode.groups.map((g, index) => {
    const levels = g.sets.reduce((n, s) => n + s.levels.length, 0);
    const sub = [g.biome ? lb('biome', g.biome) : null,
      t(g.setKind === 'Tier' ? 'mode.tiers' : 'mode.levels', { n: nf(levels) })].filter(Boolean).join(' · ');
    // Dungeons and the raid have their own artwork; a chapter is only numbered.
    return el(`<a class="card" href="#/chapter/${slug(g.key)}">
      ${g.icon
    ? thumb(g.icon, g.name)
    : `<span class="thumb" style="width:40px;height:40px;flex:none;font:600 15px var(--mono);color:var(--text-dim)">${single ? '' : index + 1}</span>`}
      <span class="card-body">
        <span class="card-title">${esc(g.name)}</span>
        <span class="card-sub">${esc(sub)}</span>
      </span></a>`);
  }));
  return frag;
}

/* ------------------------------------------------------------------ bastion */

/**
 * Bastion gets its own view because it has no authored levels at all: the waves
 * are generated, so what a reader needs is the rules and the curve, not a list.
 */
function renderBastion(mode) {
  const b = mode.bastion;

  const rules = [
    t('bastion.waveEvery', { n: b.waveSeconds }),
    t('bastion.upgradeEvery', { n: b.upgradeInterval }),
    t('bastion.bossEvery', { n: b.bossInterval }),
    // The config counts waves from zero; the first wave with assailants is the next one.
    t('bastion.assailantsFrom', { n: b.firstAssailantWave + 1 }),
  ];

  const frag = el(`<div>
    <p class="crumbs"><a href="#/modes">${esc(t('modes.title'))}</a></p>
    <div class="detail-head">
      ${thumb(mode.icon, mode.name)}
      <div>
        <h1>${esc(mode.name)}</h1>
        <div class="detail-meta">
          <span class="badge">${esc(t('bastion.endless'))}</span>
          <span class="badge">${esc(t('mode.players', { n: mode.players }))}</span>
        </div>
      </div>
    </div>
    <p class="subtitle" style="margin-top:18px">${esc(t('bastion.subtitle'))}</p>

    <ul class="pill-list bastion-rules">${rules.map((r) => `<li><span class="badge">${esc(r)}</span></li>`).join('')}</ul>

    <h2>${esc(t('bastion.scaling'))}</h2>
    <p class="empty-note">${esc(t('bastion.scalingNote', { players: mode.players }))}</p>
    <div class="table-wrap"><table>
      <thead><tr>
        <th>${esc(t('col.wave'))}</th>
        <th class="num">${esc(t('bastion.budget'))}</th>
        <th class="num">${esc(t('bastion.statsMult'))}</th>
        <th class="num">${esc(t('bastion.hpMult'))}</th>
        <th class="num">${esc(t('bastion.assailants'))}</th>
      </tr></thead>
      <tbody>${b.milestones.map((m) => `<tr>
        <td>${nf(m.wave)}${m.boss ? ` <span class="skill-kind special">${esc(lb('enemyType', 'Boss'))}</span>` : ''}</td>
        <td class="num">${nf(m.budget)}</td>
        <td class="num">×${m.statsMultiplier}</td>
        <td class="num">×${m.healthMultiplier}</td>
        <td class="num">${m.assailants || '—'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="empty-note" style="margin-top:10px">${esc(t('bastion.assailantNote', { n: b.assailantHealth }))}</p>
    <p class="empty-note">${esc(t('bastion.bossNote', { stats: b.bossStats, health: b.bossHealth }))}</p>

    <h2>${esc(t('bastion.bosses'))}</h2>
    <div class="grid" id="bosses"></div>

    <h2>${esc(t('bastion.pools'))}</h2>
    <p class="empty-note">${esc(t('bastion.poolNote'))}</p>
    <div class="panels" id="pools"></div>

    <h2>${esc(t('bastion.upgrades'))}</h2>
    <p class="empty-note">${esc(t('bastion.upgradesNote', { n: nf(b.upgrades.length) }))}</p>
    <div class="status-grid" id="upgrades"></div>
  </div>`);

  frag.getElementById('bosses').append(...b.bosses.map((boss) => el(
    boss.key
      ? `<a class="card" href="#/monster/${slug(boss.key)}">${thumb(boss.icon, boss.name)}
          <span class="card-body"><span class="card-title">${esc(boss.name)}</span></span></a>`
      : `<span class="card">${thumb(boss.icon, boss.name)}
          <span class="card-body"><span class="card-title">${esc(boss.name)}</span></span></span>`,
  )));

  frag.getElementById('pools').append(...b.pools.map((pool) => el(`<section class="panel">
    <h3>${elementBadge(pool.element, DB.meta.elementIcons?.[pool.element])}</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>${esc(t('col.monster'))}</th><th class="num">${esc(t('bastion.cost'))}</th><th class="num">${esc(t('bastion.minWave'))}</th></tr></thead>
      <tbody>${pool.enemies.map((e) => `<tr>
        <td><span class="with-icon">${iconImg(e.icon, e.name ?? '')}${
    e.key ? `<a href="#/monster/${slug(e.key)}">${esc(e.name)}</a>` : esc(e.name ?? '—')}</span></td>
        <td class="num">${nf(e.cost)}</td>
        <td class="num">${e.minWave > 0 ? nf(e.minWave) : '1'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </section>`)));

  frag.getElementById('upgrades').append(...b.upgrades.map((u) => el(`<section class="status s-up r-${cls(u.rarity)}">
    <span class="thumb status-icon">${iconImg(u.icon, u.name)}</span>
    <div class="status-body">
      <span class="status-name">${esc(u.name)}<span class="skill-kind">${esc(lb('upgradeCategory', u.category))}</span></span>
      <span class="badge rarity r-${cls(u.rarity)}">${esc(lb('rarity', u.rarity))}</span>
      <ol class="upgrade-levels">${u.levels.map((l) => `<li>${
    l.lines.length ? l.lines.map((line) => `<span>${esc(line)}</span>`).join('') : `<span>${esc(t('status.noDescription'))}</span>`
  }</li>`).join('')}</ol>
    </div>
  </section>`)));

  return frag;
}

/** Odds panels: dungeons roll an accessory, raids draw from named loot pools. */
function dropPanels(l) {
  const parts = [];

  if (l.accessoryDrop) {
    parts.push(`<section class="panel" style="margin-bottom:12px">
      <h3>${esc(t('mode.accessoryRoll'))}</h3>
      <p class="empty-note" style="margin-bottom:11px">${esc(t('mode.accessoryNote'))}</p>
      <div class="panels">
        <div><h3>${esc(t('col.tier'))}</h3><dl class="stats">${l.accessoryDrop.tiers.map((row) => `
          <div><dt>${esc(t('mode.tierN', { n: row.tier }))}</dt><dd>${row.chance}%</dd></div>`).join('')}</dl></div>
        <div><h3>${esc(t('col.rarity'))}</h3><dl class="stats">${l.accessoryDrop.rarities.map((r) => `
          <div><dt><span class="rarity-text r-${cls(r.rarity)}">${esc(lb('rarity', r.rarity))}</span></dt><dd>${r.chance}%</dd></div>`).join('')}</dl></div>
      </div>
    </section>`);
  }

  for (const pool of l.itemDrops) {
    parts.push(`<section class="panel" style="margin-bottom:12px">
      <h3>${esc(t('mode.lootPool', { name: prettifyName(pool.pool) }))}</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>${esc(t('col.item'))}</th><th class="num">${esc(t('col.chance'))}</th><th class="num">${esc(t('col.amount'))}</th></tr></thead>
        <tbody>${pool.entries.map((e) => `<tr>
          <td><span class="with-icon">${iconImg(e.icon, e.itemName ?? '')}${
            e.item ? linkItem(e.item) : esc(e.itemName ?? '—')}</span></td>
          <td class="num">${chanceCell(e.chance)}</td>
          <td class="num">${esc(amountsText(e.amounts))}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </section>`);
  }

  return parts.join('');
}

/**
 * What one entry of a location is called. Raids number their entries by
 * difficulty, dungeons by tier, chapters by level — the payload carries the index
 * and the kind, and the phrasing is chosen here so it can be translated.
 */
const levelLabel = (chapter, l) => (l.difficulty
  ? lb('difficulty', l.difficulty)
  : t(chapter.setKind === 'Tier' ? 'mode.tierN' : 'mode.level', { n: l.index }));

function renderChapter(key, params) {
  const found = IX.chapter.get(key);
  if (!found) return notFound('location', key);
  const { chapter, mode } = found;

  const available = chapter.sets.map((s) => s.label);
  const chosen = available.includes(params.get('difficulty')) ? params.get('difficulty') : available[0];
  const levels = chapter.sets.find((s) => s.label === chosen)?.levels ?? [];
  const showPicker = available.length > 1;

  const frag = el(`<div>
    <p class="crumbs"><a href="#/modes">${esc(t('modes.title'))}</a> <span class="arrow">/</span>
      <a href="#/mode/${slug(mode.key)}">${esc(mode.name)}</a></p>
    ${chapter.icon
    ? `<div class="detail-head">${thumb(chapter.icon, chapter.name)}<div><h1>${esc(chapter.name)}</h1></div></div>`
    : `<h1>${esc(chapter.name)}</h1>`}
    <p class="subtitle">${chapter.biome ? `${esc(t('mode.biomePrefix', { biome: lb('biome', chapter.biome) }))} ` : ''}${esc(t('mode.wavesOrder'))}${
      mode.players > 1 ? ` ${esc(t('mode.playedBy', { n: mode.players }))}` : ''}</p>
    <div class="filters">
      ${showPicker ? `<div class="filter-group"><span>${esc(lb('setKind', chapter.setKind))}</span>${available.map((d) => `
        <button type="button" class="chip" data-param="difficulty" data-value="${esc(d)}"
                aria-pressed="${String(d === chosen)}">${esc(lb('difficulty', d))}</button>`).join('')}</div>` : ''}
      <span class="count">${esc(t(chapter.setKind === 'Tier' ? 'mode.tiers' : 'mode.levels', { n: nf(levels.length) }))}</span>
    </div>
    <div id="levels"></div>
  </div>`);

  frag.getElementById('levels').append(...levels.map((l) => el(`<section class="panel" style="margin-bottom:14px">
    <div class="skill-head" style="justify-content:space-between;margin-bottom:10px">
      <span><span class="skill-name" style="font-size:16px">${esc(levelLabel(chapter, l))}</span>
        <span class="skill-kind">${esc(t('mode.waves', { n: nf(l.waves.length) }))}</span></span>
      <span class="biome-list">
        <span class="badge">${nf(l.cost)} ${esc(lb('currency', l.costCurrency))}</span>
        <span class="badge">${nf(l.xp)} XP</span>
        <span class="badge">${esc(t('mode.coins', { a: nf(l.coins[0]), b: nf(l.coins[1]) }))}</span>
        ${l.teamSlots ? `<span class="badge">${esc(tn('mode.slots', l.teamSlots))}</span>` : ''}
      </span>
    </div>
    ${dropPanels(l)}
    <div class="table-wrap"><table>
      <thead><tr><th>${esc(t('col.wave'))}</th><th>${esc(t('col.enemies'))}</th></tr></thead>
      <tbody>${l.waves.map((w) => `<tr>
        <td class="num">${w.index}</td>
        <td>${w.enemies.map((e) => `<span class="with-icon" style="display:inline-flex;margin-right:14px">
          ${iconImg(e.icon, e.name)}
          ${e.monster ? `<a href="#/monster/${slug(e.monster)}">${esc(e.name)}</a>` : esc(e.name)}
          ${e.count > 1 ? ` ×${e.count}` : ''}
          <span class="skill-kind${e.type === 'Boss' ? ' special' : ''}">${esc(t('col.level'))}${e.level}${e.type === 'Basic' ? '' : ` ${esc(lb('enemyType', e.type))}`}</span>
        </span>`).join('')}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </section>`)));

  wireFilters(frag);
  return frag;
}

const notFound = (kind, key) => el(`<div>
  <h1>${esc(t('error.notFound'))}</h1>
  <p class="subtitle">${esc(t('error.noSuch', { kind: t(`kind.${kind}`), key }))}</p>
  <p><a href="#/">${esc(t('error.backHome'))}</a></p>
</div>`);

/* ------------------------------------------------------------------ search */

function searchAll(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const score = (name, key) => {
    const n = name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    if (String(key).toLowerCase().includes(q)) return 3;
    return -1;
  };

  const hits = [];
  const push = (kind, name, href, icon, key) => {
    const s = score(name, key);
    if (s >= 0) hits.push({ kind, name, href, icon, s });
  };

  for (const i of DB.items) push(t('hit.Item'), i.name, `#/item/${slug(i.key)}`, i.icon, i.key);
  for (const m of DB.monsters) push(t('hit.Monster'), m.name, `#/monster/${slug(m.key)}`, m.icon, m.key);
  for (const r of DB.recipes) push(t('hit.Recipe'), r.outputName, `#/recipe/${slug(r.id)}`, IX.item.get(r.output)?.icon, r.id);
  for (const set of DB.sets) push(t('hit.Set'), set.name, `#/sets`, null, set.key);
  for (const table of DB.loot) push(t('hit.Loot'), table.sourceName, `#/loot/${slug(table.id)}`, table.icon, table.id);
  for (const b of DB.buildings) push(t('hit.Building'), b.name, `#/buildings`, b.icon, b.key);
  for (const talent of DB.talents) push(t('hit.Talent'), talent.name, `#/talents`, talent.icon, talent.key);
  for (const st of DB.statuses) push(t(st.group === 'Debuff' ? 'hit.Debuff' : 'hit.Buff'), st.name, `#/status`, st.icon, st.key);
  // Only named nodes are searchable: a stat node has no name of its own.
  for (const n of DB.skilltree?.nodes ?? []) {
    if (n.name) push(t('hit.Node'), n.name, `#/tree?class=${slug(n.classKey ?? 'all')}`, n.icon, String(n.id));
  }
  for (const m of DB.gamemodes) {
    push(t('hit.Mode'), m.name, `#/mode/${slug(m.key)}`, m.icon, m.key);
    for (const g of m.groups) push(m.key === 'adventure' ? t('hit.Chapter') : m.name, g.name, `#/chapter/${slug(g.key)}`, null, g.key);
  }

  hits.sort((a, b) => a.s - b.s || byName(a.name, b.name));
  return hits.slice(0, 12);
}

let activeSuggestion = -1;

function renderSuggestions(hits) {
  activeSuggestion = -1;
  if (!hits.length) { closeSuggestions(); return; }
  suggestions.innerHTML = hits.map((h) => `<li role="option" aria-selected="false">
    <a href="${h.href}">
      ${h.icon ? iconImg(h.icon) : '<span class="thumb" style="width:24px;height:24px"></span>'}
      <span>${esc(h.name)}</span><span class="kind">${esc(h.kind)}</span>
    </a></li>`).join('');
  suggestions.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
}

function closeSuggestions() {
  suggestions.hidden = true;
  suggestions.innerHTML = '';
  activeSuggestion = -1;
  searchInput.setAttribute('aria-expanded', 'false');
}

function moveSuggestion(delta) {
  const options = [...suggestions.querySelectorAll('li')];
  if (!options.length) return;
  options.forEach((li) => li.setAttribute('aria-selected', 'false'));
  activeSuggestion = (activeSuggestion + delta + options.length) % options.length;
  options[activeSuggestion].setAttribute('aria-selected', 'true');
  options[activeSuggestion].scrollIntoView({ block: 'nearest' });
}

searchInput.addEventListener('input', () => renderSuggestions(searchAll(searchInput.value)));

searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSuggestion(1); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveSuggestion(-1); }
  else if (ev.key === 'Enter') {
    const options = [...suggestions.querySelectorAll('li a')];
    const target = options[activeSuggestion] ?? options[0];
    if (target) { ev.preventDefault(); location.hash = target.getAttribute('href').slice(1); searchInput.blur(); }
  } else if (ev.key === 'Escape') { closeSuggestions(); searchInput.blur(); }
});

suggestions.addEventListener('click', (ev) => { if (ev.target.closest('a')) { closeSuggestions(); searchInput.value = ''; } });

document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.search')) closeSuggestions();
});

document.addEventListener('keydown', (ev) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
  if (ev.key === '/' && !typing) { ev.preventDefault(); searchInput.focus(); searchInput.select(); }
});

/* -------------------------------------------------------------------- theme */

const themeBtn = document.getElementById('theme');
const storedTheme = localStorage.getItem('pc-wiki-theme');
if (storedTheme) document.documentElement.dataset.theme = storedTheme;
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('pc-wiki-theme', next);
});

/* ------------------------------------------------------------------- router */

function route() {
  const { parts, params } = parseHash();
  const [section, ...rest] = parts;
  const key = rest.join('/');

  let content;
  try {
    switch (section) {
      case undefined: content = renderHome(); break;
      case 'items': content = renderItems(params); break;
      case 'item': content = renderItemDetail(key); break;
      case 'monsters': content = renderMonsters(params); break;
      case 'monster': content = renderMonsterDetail(key); break;
      case 'loot': content = key ? renderLootDetail(key) : renderLootList(params); break;
      case 'recipes': content = renderRecipes(params); break;
      case 'recipe': content = renderRecipeDetail(key); break;
      case 'sets': content = renderSets(); break;
      case 'buildings': content = renderBuildings(params); break;
      case 'talents': content = renderTalents(); break;
      case 'status': content = renderStatuses(params); break;
      case 'tree': content = renderTree(params); break;
      case 'combat': content = renderCombat(); break;
      case 'modes': content = renderModes(); break;
      case 'mode': content = renderMode(key); break;
      case 'chapter': content = renderChapter(key, params); break;
      default: content = notFound('page', section);
    }
  } catch (err) {
    // Without this, a render error left the previous page on screen and the only
    // clue was in the console — a tab that simply refused to open. The usual
    // cause is a browser holding an old app.js against freshly published data.
    console.error(err);
    const shortcut = '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>)';
    content = el(`<div class="warn"><b>${esc(t('error.pageFailed'))}</b>
      <p style="margin:6px 0 0">${t('error.staleCache', { shortcut })}</p>
      <p style="margin:6px 0 0">${esc(t('error.reportBug'))}
      <code>${esc(String(err && err.message ? err.message : err))}</code></p></div>`);
  }

  view.replaceChildren(content);

  const TAB_OF = { item: 'items', monster: 'monsters', recipe: 'recipes', mode: 'modes', chapter: 'modes' };
  const active = TAB_OF[section] ?? section;
  document.querySelectorAll('#tabs a').forEach((a) => {
    if (a.getAttribute('href') === `#/${active}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  document.title = section ? `${titleFor(section, key)} — ${t('home.title')}` : t('home.title');
  closeSuggestions();
  if (!rest.length) window.scrollTo(0, 0);
}

const TITLE_OF = {
  items: 'items.title', monsters: 'monsters.title', loot: 'loot.title', recipes: 'recipes.title',
  sets: 'sets.title', buildings: 'buildings.title', talents: 'talents.title', status: 'status.title', tree: 'tree.title',
  combat: 'combat.title',
  modes: 'modes.title',
};

function titleFor(section, key) {
  if (section === 'item') return IX.item.get(key)?.name ?? t('hit.Item');
  if (section === 'monster') return IX.monster.get(key)?.name ?? t('hit.Monster');
  if (section === 'recipe') return IX.recipe.get(key)?.outputName ?? t('hit.Recipe');
  if (section === 'loot' && key) return IX.loot.get(key)?.sourceName ?? t('loot.title');
  if (section === 'mode') return IX.mode.get(key)?.name ?? t('hit.Mode');
  if (section === 'chapter') return IX.chapter.get(key)?.chapter.name ?? t('hit.Chapter');
  return TITLE_OF[section] ? t(TITLE_OF[section]) : section.charAt(0).toUpperCase() + section.slice(1);
}

window.addEventListener('hashchange', route);

/* --------------------------------------------------------------------- boot */

const PAYLOADS = ['items', 'monsters', 'loot', 'recipes', 'sets', 'buildings', 'gamemodes', 'talents', 'statuses', 'skilltree', 'meta'];

/**
 * Load one language's payloads. A language is a whole data set rather than an
 * overlay, so switching language is the same code path as the first load — which
 * is the point: there is no second rendering path that can drift.
 */
async function fetchLanguage(code) {
  // The preview bundle inlines every language, so it can run from file:// where
  // fetch is blocked.
  if (window.__WIKI_DATA__) {
    const bundled = window.__WIKI_DATA__[code];
    if (!bundled) throw new Error(`the bundled preview has no "${code}" language — rebuild it with tools/bundle.mjs`);
    return PAYLOADS.map((n) => {
      if (bundled[n] === undefined) throw new Error(`the bundled preview has no "${code}/${n}" payload — rebuild it with tools/bundle.mjs`);
      return bundled[n];
    });
  }

  return Promise.all(PAYLOADS.map(async (n) => {
    const res = await fetch(`data/${code}/${n}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`data/${code}/${n}.json → HTTP ${res.status}`);
    return res.json();
  }));
}

/**
 * Stored choice, else the browser's language, else English. Which languages exist
 * is only known once a payload is loaded, so a wrong guess simply fails and
 * `boot` retries in English.
 */
function preferredLanguage() {
  const stored = localStorage.getItem(LANG_KEY);
  if (stored) return stored;
  for (const tag of navigator.languages ?? [navigator.language ?? '']) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (base) return base;
  }
  return 'en';
}

async function boot() {
  const wanted = preferredLanguage();
  try {
    let payloads;
    try {
      payloads = await fetchLanguage(wanted);
      LANG = wanted;
    } catch (err) {
      if (wanted === 'en') throw err;
      // The browser asked for a language the game does not have. Not an error.
      payloads = await fetchLanguage('en');
      LANG = 'en';
    }

    // Indexing lives inside the try as well: a payload that loads but is not what
    // the page expects used to throw here and leave "Loading game data…" on
    // screen forever, with the real error only in the console.
    install(payloads);
  } catch (err) {
    view.replaceChildren(el(`<div class="warn"><b>Could not load the wiki data.</b>
      <p style="margin:6px 0 0">${esc(err.message)}</p>
      <p style="margin:6px 0 0">Run <code>node tools/extract.mjs</code>, and serve the repository root over HTTP
      (<code>npx serve .</code>) — opening index.html from the filesystem blocks fetch.</p></div>`));
    return;
  }

  route();
}

/** Reload every payload in `code` and re-render the page the reader is on. */
async function switchLanguage(code) {
  if (code === LANG) return;
  const previous = LANG;
  try {
    const payloads = await fetchLanguage(code);
    LANG = code;
    localStorage.setItem(LANG_KEY, code);
    install(payloads);
    route();
  } catch (err) {
    console.error(err);
    // Leave the reader on a working page rather than a broken one.
    langSelect.value = previous;
  }
}

const langSelect = document.getElementById('lang');
langSelect.addEventListener('change', () => switchLanguage(langSelect.value));

/**
 * Push the loaded language's strings into the parts of the page that live in
 * index.html rather than in a render function — the tabs, the search box, the
 * footer. Marked up with `data-i18n*` so this stays one loop.
 */
function applyChrome() {
  document.documentElement.lang = LANG;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  for (const node of document.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.dataset.i18nAria));
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);

  const languages = DB.meta?.languages ?? [{ code: LANG, name: LANG }];
  langSelect.innerHTML = languages.map((l) => (
    `<option value="${esc(l.code)}"${l.code === LANG ? ' selected' : ''}>${esc(l.name)}</option>`
  )).join('');
}

/** Populate DB and the lookup indexes from the loaded payloads. */
function install(payloads) {
  [DB.items, DB.monsters, DB.loot, DB.recipes, DB.sets, DB.buildings, DB.gamemodes, DB.talents, DB.statuses, DB.skilltree, DB.meta] = payloads;

  // Keys are the project's, so they are identical in every language — but clear
  // anyway, so a language that drops an entry cannot leave the old one reachable.
  for (const index of Object.values(IX)) index.clear();

  for (const i of DB.items) IX.item.set(i.key, i);
  for (const m of DB.monsters) IX.monster.set(m.key, m);
  for (const t of DB.loot) IX.loot.set(t.id, t);
  for (const r of DB.recipes) IX.recipe.set(r.id, r);
  for (const s of DB.sets) IX.set.set(s.key, s);
  for (const b of DB.buildings) IX.building.set(b.key, b);
  for (const mode of DB.gamemodes) {
    IX.mode.set(mode.key, mode);
    for (const group of mode.groups) IX.chapter.set(group.key, { chapter: group, mode });
  }

  injectRarityColors(DB.meta.rarityColors);
  applyChrome();

  const when = new Date(DB.meta.generatedAt);
  document.getElementById('footer-meta').textContent =
    t('footer.generated', { date: when.toLocaleDateString(LANG, { dateStyle: 'medium' }) });
}

/**
 * The palette is the game's, read out of the C# source by the extractor, so the
 * two stay in step. `r-*` is the item scale, `mr-*` the monster one.
 */
function injectRarityColors(colors) {
  if (!colors) return;
  const rules = [];
  for (const [rarity, hex] of Object.entries(colors.item ?? {})) rules.push(`.r-${cls(rarity)}{--rarity:${hex}}`);
  for (const [rarity, hex] of Object.entries(colors.monster ?? {})) rules.push(`.mr-${cls(rarity)}{--rarity:${hex}}`);
  // Reused rather than appended: install() runs again on every language change.
  let style = document.getElementById('rarity-colors');
  if (!style) {
    style = document.createElement('style');
    style.id = 'rarity-colors';
    document.head.append(style);
  }
  style.textContent = rules.join('');
}

boot();
