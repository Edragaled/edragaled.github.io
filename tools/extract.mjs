#!/usr/bin/env node
// Reads the Unity project's ScriptableObjects and emits the JSON + icons the
// static wiki consumes. Run from anywhere:
//
//   node tools/extract.mjs
//   node tools/extract.mjs --project ../SomeOtherCheckout
//   PIXEL_CHRONICLES=D:\work\PixelChronicles node tools/extract.mjs
//
// This repository sits *outside* the Unity project, so the project has to be
// located rather than assumed: a `--project` argument wins, then the
// PIXEL_CHRONICLES environment variable, then a sibling folder next to this one.
//
// Everything written lands under site/ (data/ and icons/); nothing in the Unity
// project is ever modified — it is only read.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, relative, dirname, basename, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readUnityYaml, parseUnityYaml, fp } from './lib/unity-yaml.mjs';
import { assetGuid, buildPrototypeIndex, readMetaGuid, PREFAB_PROTOTYPE_FILE_ID } from './lib/quantum-guid.mjs';
import { resolveSprite } from './lib/sprite.mjs';
import { readTalentValues, fillTalentText, romanNumeral, readTalentDrawOdds } from './lib/talents.mjs';
import { readStatusEffectScripts, describeStatusEffect } from './lib/status-effects.mjs';
import { loadLanguages } from './lib/i18n.mjs';
import { loadUiStrings } from './lib/ui-strings.mjs';
import { readUpgradeScripts, effectsForLevel, fillUpgradeLine, PLAYER_UPGRADE_RARITIES, PLAYER_UPGRADE_CATEGORIES } from './lib/bastion.mjs';
import { decodeLinkedIds, assignClasses, addPrerequisites, NODE_TYPES as SKILL_NODE_TYPES, GRANT_KINDS as SKILL_GRANT_KINDS } from './lib/skilltree.mjs';
import * as E from './lib/enums.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// The repository root *is* the published website, so pushing the repo deploys it.
// `tools/` sits alongside the pages and is served as inert static files.
const SITE = join(HERE, '..');

/** Candidate Unity project roots, best first. */
function findProject() {
  const flag = process.argv.indexOf('--project');
  const candidates = [
    flag !== -1 ? process.argv[flag + 1] : null,
    process.env.PIXEL_CHRONICLES,
    join(SITE, '..', 'PixelChronicles'),
    join(SITE, '..'),                       // checked out inside the project
  ].filter(Boolean).map((p) => resolve(p));

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'Assets', 'Resources_moved', 'ScriptableObjects'))) return candidate;
  }

  console.error('Could not find the Pixel Chronicles Unity project. Looked in:');
  for (const c of candidates) console.error(`  ${c}`);
  console.error('\nPass it explicitly:  node tools/extract.mjs --project <path-to-unity-project>');
  process.exit(1);
}

const PROJECT = findProject();
const ASSETS = join(PROJECT, 'Assets');
const SO = join(ASSETS, 'Resources_moved', 'ScriptableObjects');
// The wiki app is a subfolder of the site, so marketing pages and wiki deploy
// together in one push.
const OUT = join(SITE, 'wiki');
const DATA = join(OUT, 'data');
const ICONS = join(OUT, 'icons');
const SITE_ASSETS = join(SITE, 'assets');

const MONSTER_ENTITIES = join(ASSETS, 'QuantumUser', 'Simulation', 'Entities', 'Monsters');
const WORLD_RESOURCES = join(ASSETS, 'QuantumUser', 'Simulation', 'Entities', 'WorldObjects', 'WorldResources');
const ELEMENT_ICONS = join(ASSETS, 'Resources_moved', 'UI', 'Icons', 'Elements');
const TALENT_SCRIPTS = join(ASSETS, 'QuantumUser', 'Simulation', 'AssetTypes', 'Talents');
const TALENT_ODDS = join(ASSETS, 'Core', 'Editor', 'TitleData', 'TalentTitleDataProvider.cs');
const STATUS_EFFECT_SCRIPTS = join(ASSETS, 'QuantumUser', 'Simulation', 'AssetTypes', 'StatusEffects');
const UI_STRINGS = join(HERE, 'ui');
const BASTION_UPGRADE_SCRIPTS = join(ASSETS, 'QuantumUser', 'Simulation', 'AssetTypes', 'Bastion', 'Upgrades', 'PlayerUpgrades');
const BASTION_UPGRADE_ASSETS = join(ASSETS, 'QuantumUser', 'Resources', 'DB', 'Bastion', 'PlayerUpgrades');
const SKILLTREE_CONFIG_SOURCE = join(ASSETS, 'Core', 'Scripts', 'Systems', 'SkillTreeSystem', 'SkillTreeConfig.cs');

// The biome folders under LootTables/Monsters and the generator name prefixes
// disagree on one name; the folder spelling is what the wiki shows.
const BIOME_ALIASES = { Plain: 'Plains' };
const biomeName = (s) => BIOME_ALIASES[s] ?? s;

// m_Script guids identify the C# type behind each .asset.
const SCRIPT = {
  item: 'bdfeb0f3bca14f3d8f6be8fd743e20d2',
  itemSet: 'd5c2784fc34640bf81d6765e596309fe',
  lootTable: '4be10c9866e84c599ee64539633aeb70',
  monster: '4879239ecf2547399315a51f1c50a460',
  recipe: 'f7bceb4aaea476a4ca89ac8bcf798625',
  summonConfig: 'f579e6d1ec2b42309f2fef2a1855450c',
  summonPool: '55e5fae9d9e73c749a60a088d18243b4',
  dungeon: 'd36810cf836445608105330ffc775ee6',
  raid: '9bce7cfa2dd84638974ce6c53ab9cbb5',
};

// Item categories kept out of the wiki for now. Accessories are procedurally
// generated and rolled per drop, so they need their own presentation.
const EXCLUDED_ITEM_CATEGORIES = new Set(['Accessory']);

// Summon banners that are development scaffolding rather than live content.
const EXCLUDED_SUMMON_CONFIGS = new Set(['TestEventSummonConfig']);

// Loot table folders left out. Tutorial props are scripted one-offs, not
// something a player can go and farm.
const EXCLUDED_LOOT_KINDS = new Set(['Tutorial']);

// Directories the reference scan reads. Third-party SDKs cannot mention game
// content, and skipping them keeps the pass to a few seconds.
const REFERENCE_ROOTS = ['Resources_moved', 'QuantumUser', 'Core', 'Resources', 'Settings'];

/**
 * Files that must not count as evidence that an item is used.
 *
 * `UnityDB.prefab` is the Quantum asset registry: it lists every asset in the
 * project, so without excluding it every item looks referenced. The rest is
 * content the wiki already treats as dead, and dead content should not keep an
 * item alive.
 */
const NOT_EVIDENCE = [
  /UnityDB\.prefab$/i,
  /[\\/]Unused[\\/]/i,
  /LootTables[\\/]Tutorial[\\/]/i,
  /TestEventSummonConfig\.asset$/i,
  // A bot's starting loadout is not something a player can obtain.
  /PlayerBot\.prefab$/i,
];

const warnings = [];
const warn = (msg) => { warnings.push(msg); };

// ---------------------------------------------------------------- filesystem

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

const isAsset = (p) => p.endsWith('.asset');
const posix = (p) => p.split(sep).join('/');
const num = (v) => (v == null ? 0 : Number(v));

// ------------------------------------------------------- guid -> asset path

/** Unity stores each asset's guid in its sibling `.meta`; invert that mapping. */
function buildGuidIndex() {
  const index = new Map();
  for (const meta of walk(ASSETS, (p) => p.endsWith('.meta'))) {
    const m = /^guid:\s*([0-9a-f]{32})\s*$/m.exec(readFileSync(meta, 'utf8').slice(0, 400));
    if (m) index.set(m[1], meta.slice(0, -'.meta'.length));
  }
  return index;
}

/**
 * Quantum AssetGuid -> the document that declares it. Only `.asset` files carry
 * an `Identifier` block; prefab prototypes are handled by buildPrototypeIndex.
 */
function buildQuantumIndex() {
  const index = new Map();
  for (const file of walk(ASSETS, isAsset)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('Identifier:')) continue;
    let docs;
    try { docs = parseUnityYaml(text); }
    catch { continue; }
    for (const doc of docs) {
      const value = doc.body?.Identifier?.Guid?.Value;
      if (value != null) index.set(String(value), { file, body: doc.body });
    }
  }
  return index;
}

// ------------------------------------------------------------- localization

// Term maps come from lib/i18n.mjs, one per language. Throughout the extraction
// the current language's map is named `L` or `en` — the second is historical, from
// when the wiki was English-only, and means "the language being extracted".
//
// The surrounding mSource config, which holds the Google Sheets service URL and
// password, is deliberately never touched.

/** Split PascalCase into words, for entries with no localization entry. */
const prettify = (s) => String(s ?? '')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .trim();

/**
 * Drop the `{[PREFIX]}` / `{[TIER]}` runtime placeholders that the randomly
 * named accessories carry, leaving the readable stem ("Ring", "Necklace").
 */
const displayName = (s) => String(s ?? '').replace(/\{\[[^\]]*\]\}/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Two items may legitimately share a display name (five rarities of "Ring").
 * Qualify the duplicates with their rarity so every label is distinguishable.
 */
function disambiguateNames(items) {
  const counts = new Map();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + 1);
  for (const i of items) if (counts.get(i.name) > 1) i.name = `${i.rarity} ${i.name}`;
}

// -------------------------------------------------------------------- icons

const iconJobs = new Map(); // destination relative path -> source file

/**
 * Returns a plain `icons/...` path for a standalone sprite, or
 * `{ src, crop }` when the sprite is one cell of a sheet — the site crops it with
 * CSS so the pixels are never re-encoded.
 */
function queueIcon(spriteRef, guidIndex, subdir, name) {
  if (!spriteRef?.guid) return null;
  const resolved = resolveSprite(spriteRef, guidIndex);
  if (!resolved || resolved.error) {
    if (resolved?.error) warn(`${subdir}/${name}: ${resolved.error}`);
    return null;
  }

  const src = resolved.file;
  const rel = `${subdir}/${name}${src.slice(src.lastIndexOf('.')).toLowerCase()}`;
  iconJobs.set(rel, src);
  return resolved.crop ? { src: `icons/${rel}`, crop: resolved.crop } : `icons/${rel}`;
}

function queueIconFile(src, subdir, name) {
  const rel = `${subdir}/${name}${src.slice(src.lastIndexOf('.')).toLowerCase()}`;
  iconJobs.set(rel, src);
  return `icons/${rel}`;
}

/**
 * Stamp `?v=<hash>` on the wiki's script and stylesheet.
 *
 * The data payloads and the code that reads them are separate downloads, so a
 * browser can happily pair a cached `app.js` with freshly published JSON. When the
 * shape of the data changes that combination throws, and only the page that uses
 * the changed shape breaks — a tab that silently refuses to open. Giving the code
 * a URL that changes whenever the code or the data changes makes that pairing
 * impossible.
 */
function stampAssets() {
  const page = join(OUT, 'index.html');
  if (!existsSync(page)) { warn('wiki/index.html missing — assets not stamped'); return null; }

  const hash = createHash('sha1');
  for (const file of ['app.js', 'styles.css']) hash.update(readFileSync(join(OUT, file)));
  // Recursive: the payloads live one directory down, one per language.
  for (const file of walk(DATA, (p) => p.endsWith('.json')).sort()) {
    if (basename(file) === 'meta.json') {
      // `generatedAt` moves every run; hashing it would expire every visitor's
      // cache on a regeneration that changed nothing.
      const { generatedAt, ...rest } = JSON.parse(readFileSync(file, 'utf8'));
      hash.update(JSON.stringify(rest));
      continue;
    }
    hash.update(readFileSync(file));
  }
  const version = hash.digest('hex').slice(0, 10);

  const before = readFileSync(page, 'utf8');
  const after = before
    .replace(/(href=")styles\.css(?:\?v=[^"]*)?(")/, `$1styles.css?v=${version}$2`)
    .replace(/(src=")app\.js(?:\?v=[^"]*)?(")/, `$1app.js?v=${version}$2`);

  if (!after.includes(`styles.css?v=${version}`) || !after.includes(`app.js?v=${version}`)) {
    warn('could not stamp wiki/index.html — its script or stylesheet tag no longer matches');
    return null;
  }

  if (after !== before) writeFileSync(page, after);
  return version;
}

/**
 * Empty the icon folder, then copy. Clearing first matters on Windows: its
 * filesystem is case-insensitive but case-*preserving*, so overwriting
 * `Tyrios.png` with `tyrios.png` keeps the old directory entry — and GitHub
 * Pages, which is case-sensitive, would then 404 on the icon. Files are removed
 * one by one rather than with a recursive rmdir, which trips over the file locks
 * Windows editors and indexers hold.
 */
/**
 * Drop queued icons nothing ends up pointing at. Icons are queued while reading
 * an asset, but entries are filtered afterwards (excluded categories, hidden
 * bosses), so without this the payload ships unreachable PNGs.
 */
function pruneUnreferencedIcons(payloads) {
  const referenced = new Set();
  const visit = (node) => {
    if (typeof node === 'string') { if (node.startsWith('icons/')) referenced.add(node.slice('icons/'.length)); return; }
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node && typeof node === 'object') Object.values(node).forEach(visit);
  };
  payloads.forEach(visit);

  let removed = 0;
  for (const rel of [...iconJobs.keys()]) {
    if (!referenced.has(rel)) { iconJobs.delete(rel); removed++; }
  }
  return removed;
}

function writeIcons() {
  for (const file of walk(ICONS, () => true)) {
    try { rmSync(file, { force: true, maxRetries: 3, retryDelay: 60 }); }
    catch (err) { warn(`could not clear old icon ${posix(relative(SITE, file))}: ${err.code ?? err.message}`); }
  }
  for (const [rel, src] of iconJobs) {
    const dest = join(ICONS, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

// ------------------------------------------------------------------ elements

/**
 * Artwork the marketing pages use. Copied from the project rather than kept by
 * hand so the landing page cannot drift from the game's own logo and icon.
 */
function copySiteAssets() {
  const wanted = [
    ['logo.png', join(ASSETS, 'Resources_moved', 'TitleScreen', 'PixelChroniclesLogo.png')],
    ['hero.png', join(ASSETS, 'Resources', 'GameIcons', 'GameIcon1.png')],
    ['studio.png', join(ASSETS, 'Resources', 'SplashScreen', 'MoonForgeLogo.png')],
  ];

  mkdirSync(SITE_ASSETS, { recursive: true });
  const copied = [];
  for (const [name, src] of wanted) {
    if (!existsSync(src)) { warn(`site asset missing: ${posix(relative(ASSETS, src))}`); continue; }
    copyFileSync(src, join(SITE_ASSETS, name));
    copied.push(name);
  }
  return copied;
}

/** Element name -> icon path. There is no artwork for Neutral. */
function extractElementIcons() {
  const icons = {};
  for (const element of E.Elements) {
    const file = join(ELEMENT_ICONS, `${element}Element.png`);
    if (existsSync(file)) icons[element] = queueIconFile(file, 'elements', element.toLowerCase());
  }
  const missing = E.Elements.filter((e) => !icons[e] && e !== 'Neutral');
  if (missing.length) warn(`no element icon for ${missing.join(', ')}`);
  return icons;
}

// --------------------------------------------------------------- asset docs

function loadDocs(files) {
  const out = [];
  for (const file of files) {
    let docs;
    try { docs = readUnityYaml(file); }
    catch (err) { warn(`failed to parse ${posix(relative(PROJECT, file))}: ${err.message}`); continue; }
    for (const doc of docs) out.push({ file, doc });
  }
  return out;
}

const scriptGuid = (doc) => doc.body?.m_Script?.guid ?? null;

/**
 * Flatten a prefab's variant overrides into `propertyPath -> modification`. The
 * whole modification is kept, not just `value`: asset references live in
 * `objectReference` and leave `value` empty.
 */
function prefabOverrides(docs) {
  const out = new Map();
  for (const doc of docs) {
    for (const mod of doc.body?.m_Modification?.m_Modifications ?? []) {
      if (mod?.propertyPath != null && !out.has(mod.propertyPath)) out.set(mod.propertyPath, mod);
    }
  }
  return out;
}

// -------------------------------------------------------------------- items

function extractItems(guidIndex, en) {
  const items = [];
  const byGuid = new Map();
  const fileByKey = new Map();

  for (const { file, doc } of loadDocs(walk(join(SO, 'Items'), isAsset))) {
    if (scriptGuid(doc) !== SCRIPT.item) continue;
    const b = doc.body;
    const relPath = posix(relative(join(SO, 'Items'), file)).replace(/\.asset$/, '');
    const slot = E.named(E.EquipSlots, b.EquipSlot, 'None');
    const isWeapon = !!(b.IsWeapon ?? b.IsSword);
    const key = b._friendlyId || basename(file, '.asset');
    const category = categoriseItem(relPath, b, isWeapon);
    // Excluded items are still built so loot and recipe references resolve, but
    // there is no point resolving artwork that will be pruned.
    const wanted = !EXCLUDED_ITEM_CATEGORIES.has(category);

    const item = {
      id: b._id,
      // `Name` is the localization key and is shared by every tier of the
      // procedurally-named accessories, so it cannot identify an item.
      // `_friendlyId` is unique across all items and reads well in a URL.
      key,
      nameKey: b.Name,
      name: displayName(en.get(`Item/${b.Name}`) ?? prettify(b.Name)),
      category,
      group: relPath.split('/').slice(0, -1).join('/') || 'Misc',
      rarity: E.named(E.ItemRarities, b.Rarity, 'Common'),
      rarityIndex: Number(b.Rarity ?? 0),
      slot: slot === 'None' ? null : slot,
      stats: {
        health: num(b.Health),
        attack: num(b.Attack),
        defense: num(b.Defense),
        attackSpeed: fp(b.AttackSpeed) || null,
      },
      tool: b.IsTool ? { type: E.named(E.ToolTypes, b.ToolType, 'None'), tier: num(b.ToolTier), damage: num(b.ToolDamage) } : null,
      isWeapon,
      maxStack: num(b.MaxAmount) || 1,
      upgradable: !!b.IsUpgradable,
      maxCharges: num(b.MaxCharges) || null,
      icon: wanted ? queueIcon(b.Sprite, guidIndex, 'items', key) : null,
      tags: [],          // filled in by tagItems(), once drops and recipes are linked
      droppedBy: [],
      craftedBy: [],
      usedIn: [],
      set: null,
    };

    // Zero-valued stats are noise on materials; drop them entirely.
    if (!item.stats.health && !item.stats.attack && !item.stats.defense && !item.stats.attackSpeed) {
      item.stats = null;
    }

    items.push(item);
    fileByKey.set(key, file);
    const g = readMetaGuid(file);
    if (g) byGuid.set(g, item);
  }

  disambiguateNames(items);
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { items, byGuid, fileByKey };
}

function categoriseItem(relPath, b, isWeapon) {
  const top = relPath.split('/')[0];
  if (top === 'Weapons') return 'Weapon';
  if (top === 'Armors') return 'Armor';
  if (top === 'Accessories') return 'Accessory';
  if (top === 'Materials') return 'Material';
  if (top === 'Tools') return 'Tool';
  if (top === 'PremiumItems') return 'Premium';
  if (isWeapon) return 'Weapon';
  if (b.IsTool) return 'Tool';
  return 'Other';
}

// ---------------------------------------------------------------- item sets

function extractSets(en, itemsByGuid) {
  const sets = [];
  for (const { file, doc } of loadDocs(walk(join(SO, 'Items', 'ItemSets'), isAsset))) {
    if (scriptGuid(doc) !== SCRIPT.itemSet) continue;
    const b = doc.body;
    sets.push({
      key: b._nameKey,
      name: en.get(`Item/Set/${b._nameKey}`) ?? prettify(b._nameKey),
      pieces: (b.Items ?? []).map((ref) => itemsByGuid.get(ref?.guid)?.key).filter(Boolean),
      associatedWeapon: itemsByGuid.get(b.AssociatedSword?.guid)?.key ?? null,
      bonuses: (b.StatSetEffects ?? []).map((e) => formatStat(e.StatIndex, e.Value, e.IsFlat)),
    });
  }
  sets.sort((a, b) => a.name.localeCompare(b.name));
  return sets;
}

function formatStat(statIndex, value, isFlat) {
  const stat = E.named(E.StatIndexes, statIndex, `Stat ${statIndex}`);
  const raw = fp(value);
  const percent = !isFlat || E.PercentStats.has(stat);
  return {
    stat,
    value: percent ? Math.round(raw * 1000) / 10 : Math.round(raw),
    unit: percent ? '%' : 'flat',
  };
}

// ------------------------------------------------------------ combat levels

/**
 * One pass over the 123 combat levels. Yields where each monster appears (and in
 * what role) plus the resource generators, which are the only place that ties a
 * harvestable resource to a biome.
 */
function scanCombatLevels() {
  const appearances = new Map(); // monster friendlyId -> Set("Chapters:Boss")
  const generators = [];         // { biome, difficulty, chapter, file }

  for (const file of walk(join(SO, 'CombatLevels'), isAsset)) {
    const rel = posix(relative(join(SO, 'CombatLevels'), file));
    const area = rel.split('/')[0]; // Chapters | Dungeons | Raids
    const name = basename(file, '.asset');

    const generatorMatch = /^(.+?)(Normal|Hard|Master)_Resources?Generator$/.exec(name);
    if (generatorMatch) {
      generators.push({
        biome: biomeName(prettify(generatorMatch[1])),
        difficulty: generatorMatch[2],
        chapter: rel.split('/')[1] ?? null,
        file,
      });
      continue;
    }

    // Walking raw lines is far cheaper than parsing these very large documents,
    // and the two fields we need always appear in this order per enemy.
    let current = null;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const enemy = /^\s*EnemyFriendlyId:\s*(\S+)\s*$/.exec(line);
      if (enemy) { current = enemy[1]; continue; }
      const type = /^\s*Type:\s*(\d+)\s*$/.exec(line);
      if (type && current) {
        const role = E.named(E.EnemyTypes, type[1], 'Basic');
        if (!appearances.has(current)) appearances.set(current, new Set());
        appearances.get(current).add(`${area}:${role}`);
        current = null;
      }
    }
  }

  return { appearances, generators };
}

/**
 * Every harvestable prefab, indexed by the loot table it drops. Built from the
 * prefabs themselves rather than from the generators, so tutorial props and
 * chests — which no generator spawns — still get an icon.
 */
function scanResourcePrefabs(guidIndex) {
  const byLootTable = new Map(); // AssetGuid -> Map(prefab name -> { prefab, sprite })

  for (const prefab of walk(WORLD_RESOURCES, (p) => p.endsWith('.prefab'))) {
    const docs = readUnityYaml(prefab);
    const lootGuid = prefabOverrides(docs).get('Prototype.LootTable.Id.Value')?.value;
    if (lootGuid == null || String(lootGuid) === '0') continue; // e.g. Bush drops nothing

    const key = String(lootGuid);
    if (!byLootTable.has(key)) byLootTable.set(key, new Map());
    byLootTable.get(key).set(basename(prefab, '.prefab'), { prefab, sprite: resourceIconRef(prefab, guidIndex) });
  }
  return byLootTable;
}

/**
 * The icon the WorldResource component declares — the authored single frame, not
 * the scene renderer's sprite, which for trees and cacti is one cell of an
 * animation sheet. Follows the variant chain: biome chests override only their
 * loot table and inherit `ResourceIcon` from `Chest.prefab`.
 */
function resourceIconRef(file, guidIndex, seen = new Set()) {
  if (seen.has(file)) return null;
  seen.add(file);

  const docs = readUnityYaml(file);

  const icon = prefabOverrides(docs).get('Prototype.ResourceIcon');
  if (icon?.objectReference?.guid) return icon.objectReference;
  for (const doc of docs) {
    const direct = doc.body?.Prototype?.ResourceIcon;
    if (direct?.guid) return direct;
  }

  for (const doc of docs) {
    const guid = doc.body?.m_SourcePrefab?.guid;
    const parent = guid && guidIndex.get(guid);
    if (parent && parent.endsWith('.prefab')) {
      const found = resourceIconRef(parent, guidIndex, seen);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Resource loot table -> the biomes it can be harvested in.
 *
 * A resource's biome exists nowhere on the resource itself: several biomes share
 * the same prefab (every ore lives in a single `Rocks/` folder) and several
 * prefabs share one loot table (all tree variants drop from `Tree_LootTable`).
 * The only authority is the per-biome, per-difficulty ResourceGenerator that
 * spawns them.
 */
function scanResourceSpawns(generators, prototypeIndex, resourcePrefabs) {
  const lootTableOf = new Map(); // prefab path -> loot table AssetGuid
  for (const [lootGuid, prefabs] of resourcePrefabs) {
    for (const { prefab } of prefabs.values()) lootTableOf.set(prefab, lootGuid);
  }

  const spawns = new Map(); // loot table AssetGuid -> { biomes, entries }
  for (const gen of generators) {
    const body = readUnityYaml(gen.file)[0]?.body;
    for (const resource of body?.Resources ?? []) {
      const id = String(resource.EntityPrototypeRef?.Id?.Value ?? '');
      const prefab = prototypeIndex.get(id);
      if (!prefab) { warn(`${basename(gen.file, '.asset')} references prototype ${id} with no prefab`); continue; }

      const lootGuid = lootTableOf.get(prefab);
      if (!lootGuid) continue;

      if (!spawns.has(lootGuid)) spawns.set(lootGuid, { biomes: new Set(), entries: [] });
      const entry = spawns.get(lootGuid);
      entry.biomes.add(gen.biome);
      entry.entries.push({
        biome: gen.biome,
        difficulty: gen.difficulty,
        resource: basename(prefab, '.prefab'),
        spawnChance: Math.round(fp(resource.Probability) * 1000) / 10,
      });
    }
  }
  return spawns;
}

/**
 * Pick the artwork for a loot table's source: prefer the prefab named like the
 * table (`Tree_LootTable` -> `Tree.prefab`) over the variants sharing it
 * (`SwampTree`, `Pine Tree`, …).
 */
function sourceIcon(prefabs, tableName, guidIndex, name) {
  if (!prefabs) return null;
  const loose = tableName.replace(/\s+/g, '').toLowerCase();
  const match = prefabs.get(tableName)
    ?? [...prefabs.entries()].find(([n]) => n.replace(/\s+/g, '').toLowerCase() === loose)?.[1]
    ?? [...prefabs.values()][0];
  return match?.sprite ? queueIcon(match.sprite, guidIndex, 'sources', name) : null;
}

// --------------------------------------------------------------- loot tables

function extractLootTables(guidIndex, en, itemsByGuid, spawns, resourcePrefabs) {
  const tables = [];
  const byQuantumGuid = new Map();

  for (const { file, doc } of loadDocs(walk(join(SO, 'LootTables'), isAsset))) {
    if (scriptGuid(doc) !== SCRIPT.lootTable) continue;
    const b = doc.body;
    const relPath = posix(relative(join(SO, 'LootTables'), file)).replace(/\.asset$/, '');
    const parts = relPath.split('/');
    const folder = parts[0];                     // Monsters | Chests | Resources | Tutorial
    if (EXCLUDED_LOOT_KINDS.has(folder)) continue;
    // Tolerant of the misspelled assets: VolcaniteOre_LooTable is missing a `t`,
    // and without this the wiki showed a source called "Volcanite Ore_Loo Table".
    const rawName = basename(relPath).replace(/_Lo+t?Table$/i, '');
    const quantumGuid = b.Identifier?.Guid?.Value != null ? String(b.Identifier.Guid.Value) : null;
    const spawn = quantumGuid ? spawns.get(quantumGuid) : null;

    // Only harvestable prefabs live under WorldObjects/WorldResources, so being
    // indexed there settles what a table really is when the folder disagrees —
    // DesertTree_LootTable sits in LootTables/Monsters/Desert but is a tree.
    const harvestable = quantumGuid ? resourcePrefabs.get(quantumGuid) : null;
    let kind = folder;
    if (harvestable && folder === 'Monsters') {
      kind = 'Resources';
      warn(`${relPath} is a harvestable resource filed under Monsters/ — shown as a resource`);
    }

    const table = {
      id: relPath,
      quantumGuid,
      kind,
      sourceKey: rawName,
      sourceName: lootSourceName(kind, rawName, en),
      // Monster tables are filed under a biome folder; harvestables get theirs
      // from the generators that spawn them, and can belong to several.
      biomes: kind === 'Monsters'
        ? (parts.length > 2 ? [biomeName(parts[1])] : [])
        : [...(spawn?.biomes ?? (parts.length > 2 ? [biomeName(parts[1])] : []))].sort(),
      spawns: spawn?.entries.sort((a, b2) => a.biome.localeCompare(b2.biome) || a.difficulty.localeCompare(b2.difficulty)) ?? [],
      icon: sourceIcon(harvestable, rawName, guidIndex, rawName.toLowerCase()),
      entries: (b.LootEntries ?? []).map((entry) => {
        const item = itemsByGuid.get(entry.Item?.guid);
        if (!item) warn(`loot table ${relPath} references unknown item guid ${entry.Item?.guid}`);
        return {
          item: item?.key ?? null,
          itemName: item?.name ?? `(missing item ${entry.Item?.guid ?? '?'})`,
          chance: {
            normal: pct(entry.NormalProbability),
            hard: pct(entry.HardProbability),
            master: pct(entry.MasterProbability),
          },
          amounts: amountDistribution(entry.Count),
        };
      }),
    };

    tables.push(table);
    if (quantumGuid) byQuantumGuid.set(quantumGuid, table);
  }

  tables.sort((a, b) => a.sourceName.localeCompare(b.sourceName));
  return { tables, byQuantumGuid };
}

function lootSourceName(kind, rawName, en) {
  if (kind === 'Monsters') return en.get(`Monster/${rawName}`) ?? prettify(rawName);
  return en.get(`Resource/${rawName}`) ?? prettify(rawName);
}

const pct = (v) => (v == null ? null : Math.round(Number(v) * 1000) / 10);

/** RNGNeeds probability list -> `[{ amount, chance }]`, chance in percent. */
function amountDistribution(count) {
  return (count?.m_ProbabilityItems ?? [])
    .filter((p) => p.m_Enabled !== 0)
    .map((p) => ({ amount: num(p.m_Value), chance: pct(p.m_BaseProbability) }))
    .sort((a, b) => a.amount - b.amount);
}

// ----------------------------------------------------------------- monsters

/** Monster stats live on the Quantum entity prefab, mostly as prefab-variant overrides. */
function monsterPrefabIndex() {
  const index = new Map();
  for (const file of walk(MONSTER_ENTITIES, (p) => p.endsWith('.prefab'))) {
    index.set(basename(file, '.prefab'), file);
  }
  return index;
}

function readPrefabStats(file, guidIndex, seen = new Set()) {
  if (seen.has(file)) return {};
  seen.add(file);

  const docs = readUnityYaml(file);
  const stats = {};
  const skillGuids = [];
  const passiveGuids = [];

  const put = (path, value) => {
    const set = (k, v) => { if (stats[k] == null) stats[k] = v; };
    switch (path) {
      case 'Prototype.Health': set('health', num(value)); break;
      case 'Prototype.Attack': set('attack', num(value)); break;
      case 'Prototype.Defense': set('defense', num(value)); break;
      case 'Prototype.WeightedStats': set('weightedStats', num(value)); break;
      case 'Prototype.AttackSpeed.RawValue': set('attackSpeed', fp(value)); break;
      case 'Prototype.AttackInterval.RawValue': set('attackInterval', fp(value)); break;
      case 'Prototype.Element.Value': set('element', E.named(E.Elements, value, 'Neutral')); break;
      // Quantum writes 0 for "no asset"; the base prefab does exactly that.
      case 'Prototype.LootTable.Id.Value': if (String(value) !== '0') set('lootTableGuid', String(value)); break;
      default: break;
    }
    const skill = /^Prototype\.Skills\.Array\.data\[(\d+)\]\.SkillData\.Id\.Value$/.exec(path);
    if (skill) skillGuids[Number(skill[1])] = String(value);
    if (path === 'Prototype.Passive.PassiveData.Id.Value' && String(value) !== '0') passiveGuids.push(String(value));
  };

  // Prefab variants: values arrive as property-path overrides.
  for (const [path, mod] of prefabOverrides(docs)) put(path, mod.value);

  // Plain prefabs: values sit directly on the component's Prototype block.
  for (const doc of docs) {
    const proto = doc.body?.Prototype;
    if (!proto || typeof proto !== 'object') continue;
    if (proto.Health != null) put('Prototype.Health', proto.Health);
    if (proto.Attack != null) put('Prototype.Attack', proto.Attack);
    if (proto.Defense != null) put('Prototype.Defense', proto.Defense);
    if (proto.WeightedStats != null) put('Prototype.WeightedStats', proto.WeightedStats);
    if (proto.AttackSpeed?.RawValue != null) put('Prototype.AttackSpeed.RawValue', proto.AttackSpeed.RawValue);
    if (proto.AttackInterval?.RawValue != null) put('Prototype.AttackInterval.RawValue', proto.AttackInterval.RawValue);
    if (proto.Element?.Value != null) put('Prototype.Element.Value', proto.Element.Value);
    if (proto.LootTable?.Id?.Value != null) put('Prototype.LootTable.Id.Value', proto.LootTable.Id.Value);
  }

  stats.skillGuids = skillGuids.filter(Boolean);
  stats.passiveGuids = passiveGuids;

  // Anything this variant does not override is inherited from the prefab it was
  // created from ("Monster base.prefab" holds the defaults), so walk up.
  if (stats.health == null || stats.attack == null || stats.defense == null) {
    for (const doc of docs) {
      const guid = doc.body?.m_SourcePrefab?.guid;
      const parent = guid && guidIndex.get(guid);
      if (!parent || !parent.endsWith('.prefab')) continue;
      const inherited = readPrefabStats(parent, guidIndex, seen);
      for (const [k, v] of Object.entries(inherited)) {
        if (stats[k] == null || (Array.isArray(stats[k]) && stats[k].length === 0)) stats[k] = v;
      }
      if (stats.health != null && stats.attack != null && stats.defense != null) break;
    }
  }

  return stats;
}

function extractMonsters({ guidIndex, quantumIndex, en, lootByQuantumGuid, appearances, elementIcons }) {
  const prefabs = monsterPrefabIndex();
  const monsters = [];
  const hidden = [];
  const byGuid = new Map();
  // Name and icon for every monster including the hidden bosses, so a raid or
  // dungeon wave can still show its boss even though it has no wiki page.
  const displayByKey = new Map();
  // Bastion references its enemies by prefab rather than by monster asset.
  const keyByPrefab = new Map();

  for (const { file, doc } of loadDocs(walk(join(SO, 'Monsters'), isAsset))) {
    if (scriptGuid(doc) !== SCRIPT.monster) continue;
    const b = doc.body;
    const prefabName = basename(file, '.asset').replace(/Data$/, '');
    const nameKey = b._nameKey || prefabName;
    const key = b._friendlyId || prefabName;
    const prefab = prefabs.get(prefabName);

    let stats = {};
    if (prefab) stats = readPrefabStats(prefab, guidIndex);
    else warn(`no prefab found for monster ${prefabName} — stats and loot table unavailable`);

    // Wave roles are only used to spot raid bosses. They are not published: the
    // same monster is Basic in one stage and Elite in another, so the label says
    // something about the encounter, not about the monster.
    const roles = [...(appearances.get(key) ?? [])].sort();
    const displayName = en.get(`Monster/${nameKey}`) ?? prettify(nameKey);
    displayByKey.set(key, { name: displayName, icon: queueIcon(b.Icon, guidIndex, 'monsters', key) });
    keyByPrefab.set(prefabName, key);
    if (isRaidExclusiveBoss(roles)) { hidden.push(key); continue; }

    const lootTable = stats.lootTableGuid ? lootByQuantumGuid.get(stats.lootTableGuid) : null;
    if (stats.lootTableGuid && !lootTable) {
      warn(`monster ${key} references loot table guid ${stats.lootTableGuid} with no matching asset`);
    }

    const element = stats.element ?? 'Neutral';
    const monster = {
      id: b._id,
      key,
      nameKey,
      name: displayName,
      rarity: E.named(E.MonsterRarities, b.Rarity, 'Common'),
      rarityIndex: Number(b.Rarity ?? 0),
      element,
      elementIcon: elementIcons[element] ?? null,
      environment: E.named(E.EnvironmentDisplays, b.EnvironmentDisplay, null),
      obtainable: !!b.Obtainable,
      stats: {
        health: stats.health ?? null,
        attack: stats.attack ?? null,
        defense: stats.defense ?? null,
        attackSpeed: stats.attackSpeed ?? null,
        attackInterval: stats.attackInterval ?? null,
        weightedStats: stats.weightedStats ?? null,
      },
      skills: monsterSkills(nameKey, stats, quantumIndex, guidIndex, en),
      icon: displayByKey.get(key).icon,
      lootTable: lootTable?.id ?? null,
      // filled in by extractSummons()
      summon: [],
      summonable: false,
    };

    monsters.push(monster);
    const assetGuid = readMetaGuid(file);
    if (assetGuid) byGuid.set(assetGuid, monster);
  }

  monsters.sort((a, b) => a.name.localeCompare(b.name));
  return { monsters, hidden, byGuid, displayByKey, keyByPrefab };
}

/**
 * A monster is treated as a boss — and left out of the wiki — when every
 * appearance it has is a Boss role *and* none of them is in a story chapter.
 * That distinguishes the raid/dungeon bosses (Noxyros, Copper Goliath) from the
 * chapter bosses players farm on the way through the campaign. Monsters that
 * appear in no level yet are kept: they are unreleased content, not bosses.
 */
function isRaidExclusiveBoss(roles) {
  if (!roles.length) return false;
  return roles.every((r) => r.endsWith(':Boss')) && !roles.some((r) => r.startsWith('Chapters:'));
}

/**
 * Pair the skill assets on the prefab with their localized text. The array order
 * does not track the skill number (Noxyros has `_Skill_5` at index 2), so the
 * number comes from the asset name and the index is only a fallback.
 */
function monsterSkills(nameKey, stats, quantumIndex, guidIndex, en) {
  const skills = [];

  (stats.skillGuids ?? []).forEach((guid, index) => {
    const asset = quantumIndex.get(guid);
    if (!asset) { warn(`monster ${nameKey} skill ${guid} not found`); return; }
    const numbered = /_Skill_(\d+)$/.exec(asset.body.m_Name ?? '');
    const slot = numbered ? Number(numbered[1]) : index + 1;
    const name = en.get(`Monster/${nameKey}/Skill${slot}Name`);
    if (!name) return; // undocumented internal skill — nothing to show
    skills.push({
      slot,
      // Skill 3 is the monster's special; 1 and 2 are its basic kit.
      kind: slot === 3 ? 'Special' : `Skill ${slot}`,
      name,
      description: en.get(`Monster/${nameKey}/Skill${slot}Description`) ?? null,
      icon: queueIcon(asset.body.Icon, guidIndex, 'skills', `${nameKey}-skill-${slot}`.toLowerCase()),
    });
  });

  skills.sort((a, b) => a.slot - b.slot);

  const passiveName = en.get(`Monster/${nameKey}/PassiveName`);
  if (passiveName) {
    const asset = (stats.passiveGuids ?? []).map((g) => quantumIndex.get(g)).find(Boolean);
    skills.push({
      slot: 99,
      kind: 'Passive',
      name: passiveName,
      description: en.get(`Monster/${nameKey}/PassiveDescription`) ?? null,
      icon: asset ? queueIcon(asset.body.Icon, guidIndex, 'skills', `${nameKey}-passive`.toLowerCase()) : null,
    });
  }

  return skills;
}

// ------------------------------------------------------------------ summons

/**
 * Summoning is the other way to obtain a monster, and for several of them the
 * only one: they appear in no combat-level wave at all. Walks each
 * SummonConfigData -> its SummonPools -> the monsters in each pool, and attaches
 * the result to the monsters it names.
 *
 * Deliberately records *availability only*, never odds. Summon rates are retuned
 * with every banner and are already shown in-game, so a copy here would be a
 * maintenance burden that goes stale silently.
 *
 * Event banners are skipped entirely: they run for a limited time and then
 * vanish, and the wiki only carries data that stays true.
 */
function extractSummons(en, monstersByGuid, itemsByGuid) {
  const pools = new Map(); // asset guid -> pool
  for (const { file, doc } of loadDocs(walk(join(SO, 'Summon'), isAsset))) {
    if (scriptGuid(doc) !== SCRIPT.summonPool) continue;
    const b = doc.body;
    const guid = readMetaGuid(file);
    if (!guid) continue;
    pools.set(guid, {
      name: basename(file, '.asset'),
      rarity: E.named(E.MonsterRarities, b.PoolRarity ?? 0, 'Common'),
      monsters: (b._monsterPool?.m_ProbabilityItems ?? [])
        .filter((p) => p.m_Enabled !== 0)
        .map((p) => ({ guid: p.m_Value?.guid })),
    });
  }

  const banners = [];
  for (const { file, doc } of loadDocs(walk(join(SO, 'Summon'), isAsset))) {
    if (scriptGuid(doc) !== SCRIPT.summonConfig) continue;
    const b = doc.body;
    if (EXCLUDED_SUMMON_CONFIGS.has(b.ConfigId) || b.IsEvent) continue;
    const banner = {
      id: b.ConfigId || basename(file, '.asset'),
      name: prettify(basename(file, '.asset').replace(/Config$/, '')),
      costItem: itemsByGuid.get(b.ItemToUse?.guid)?.key ?? null,
      costItemName: itemsByGuid.get(b.ItemToUse?.guid)?.name ?? null,
      pools: [],
    };

    for (const entry of b.SummonPools?.m_ProbabilityItems ?? []) {
      if (entry.m_Enabled === 0) continue;
      const pool = pools.get(entry.m_Value?.guid);
      if (!pool) { warn(`summon config ${banner.id} references an unknown pool`); continue; }

      banner.pools.push({ pool: pool.name, rarity: pool.rarity });

      for (const member of pool.monsters) {
        const monster = monstersByGuid.get(member.guid);
        if (!monster) continue; // hidden boss, or a monster this build no longer ships
        monster.summon.push({
          banner: banner.id,
          bannerName: banner.name,
          pool: pool.name,
          poolRarity: pool.rarity,
        });
      }
    }

    banners.push(banner);
  }

  for (const monster of monstersByGuid.values()) {
    monster.summon.sort((a, b) => a.bannerName.localeCompare(b.bannerName));
    monster.summonable = monster.summon.length > 0;
  }

  banners.sort((a, b) => a.name.localeCompare(b.name));
  return banners;
}

// ------------------------------------------------------------------ recipes

function extractRecipes(itemsByGuid) {
  const recipes = [];
  for (const { file, doc } of loadDocs(walk(join(SO, 'Recipes'), isAsset))) {
    if (scriptGuid(doc) !== SCRIPT.recipe) continue;
    const b = doc.body;
    const relPath = posix(relative(join(SO, 'Recipes'), file)).replace(/\.asset$/, '');
    if (relPath.startsWith('Unused/')) continue; // experiments, not shipped content

    const output = itemsByGuid.get(b._outputItem?.guid);
    if (!output) { warn(`recipe ${relPath} has an unresolved output item — skipped`); continue; }

    recipes.push({
      id: relPath,
      output: output.key,
      outputName: output.name,
      outputAmount: num(b._outputItemAmount) || 1,
      category: E.named(E.RecipeCategories, b._recipeCategory, 'All'),
      station: E.named(E.StationTypes, b._stationType, 'None'),
      stationLevel: num(b._stationLevelRequired),
      ingredients: (b._ingredients ?? []).map((ing) => {
        const item = itemsByGuid.get(ing.ItemData?.guid);
        if (!item) warn(`recipe ${relPath} references unknown ingredient guid ${ing.ItemData?.guid}`);
        return {
          item: item?.key ?? null,
          itemName: item?.name ?? `(missing item ${ing.ItemData?.guid ?? '?'})`,
          amount: num(ing.Amount),
        };
      }),
    });
  }
  recipes.sort((a, b) => a.outputName.localeCompare(b.outputName));
  return recipes;
}

// ---------------------------------------------------------------- buildings

/**
 * The buildings a player can buy, using the game's own test for that:
 * `!StartsAtLevelZero && BuyBuildingCost != null`
 * (BuildingBuyCostTitleDataProvider). The ones left out start as ruins on the
 * player's island and are repaired rather than purchased.
 *
 * `BuildingCosts` is indexed by level - 1, so entry 0 is the purchase and the
 * rest are upgrades.
 */
function extractBuildings(guidIndex, en, itemsByGuid) {
  const buildings = [];

  for (const { file, doc } of loadDocs(walk(join(SO, 'Building'), isAsset))) {
    const b = doc.body;
    if (b.NameKey == null || !Array.isArray(b.BuildingCosts)) continue;

    const costs = b.BuildingCosts.map((c, index) => ({
      level: index + 1,
      currency: E.named(E.Currencies, c.Currency, 'Coin'),
      amount: num(c.CurrencyAmount),
      materials: (c.Materials ?? []).map((m) => {
        const item = itemsByGuid.get(m.ItemData?.guid);
        return { item: item?.key ?? null, itemName: item?.name ?? null, amount: num(m.Amount) };
      }).filter((m) => m.item),
      buildSeconds: num(c.Hours) * 3600 + num(c.Minutes) * 60 + num(c.Seconds),
    }));

    if (b.StartsAtLevelZero || !costs.length) continue;

    const key = b._friendlyId || basename(file, '.asset');
    buildings.push({
      key,
      nameKey: b.NameKey,
      name: en.get(`Building/${b.NameKey}`) ?? prettify(b.NameKey),
      description: en.get(`Building/${b.NameKey}Description`) ?? null,
      category: E.named(E.BuildingShopCategories, b.ShopCategory, 'Main'),
      maxLevel: costs.length,
      purchase: costs[0],
      upgrades: costs.slice(1),
      unlimited: !!b.UnlimitedBuildAmount,
      icon: queueIcon((b.BuildingIcons ?? [])[0], guidIndex, 'buildings', key),
    });
  }

  buildings.sort((a, b) => a.name.localeCompare(b.name));
  return buildings;
}

// --------------------------------------------------------------- skill tree

/**
 * The player skill tree.
 *
 * There is no single tree asset: every node is its own ScriptableObject holding
 * its grants, its price and its outgoing links, so the graph is rebuilt from all
 * of them. Positions are authored, which is what lets the site draw the same map
 * the game draws.
 */
function extractSkillTree(guidIndex, quantumIndex, L, itemsByGuid) {
  const root = join(SO, 'SkillTree');
  if (!existsSync(root)) { warn('no SkillTree folder — the skill tree is skipped'); return null; }

  const config = readUnityYaml(join(root, 'SkillTreeConfig.asset'))[0]?.body ?? {};
  const source = readFileSync(SKILLTREE_CONFIG_SOURCE, 'utf8');
  // Two prices were added to the class after the asset was last written, so Unity
  // never serialized them: the C# initializer is what the game actually uses.
  const csDefault = (field) => Number(/=\s*(\d+)\s*;/.exec(
    new RegExp(`private\\s+int\\s+${field}\\s*=[^;]*;`).exec(source)?.[0] ?? '',
  )?.[1] ?? 0);
  const csDefaultList = (field) => (/\{([^}]*)\}/.exec(
    new RegExp(`private\\s+List<int>\\s+${field}\\s*=[^;]*;`).exec(source)?.[0] ?? '',
  )?.[1] ?? '').split(',').map((n) => Number(n.trim())).filter(Number.isFinite);

  const activation = new Map();
  for (const cost of config._activationCosts ?? []) {
    activation.set(E.named(SKILL_NODE_TYPES, cost.Type, 'Minor'), num(cost.Points));
  }

  const statIcons = new Map();
  const iconSet = config._statIcons?.guid && guidIndex.get(config._statIcons.guid);
  for (const entry of (iconSet ? readUnityYaml(iconSet)[0]?.body?._entries ?? [] : [])) {
    const stat = E.named(E.StatIndexes, entry.Index, null);
    if (!stat) continue;
    statIcons.set(stat, queueIcon(entry.Icon, guidIndex, 'skilltree', `stat_${cleanKey(stat)}`));
  }

  const classes = [];
  const classByGuid = new Map();
  for (const file of walk(root, (p) => isAsset(p) && /Class\.asset$/.test(p))) {
    const b = readUnityYaml(file)[0]?.body;
    if (!b?._name) continue;
    const entry = {
      key: cleanKey(b._name),
      id: num(b._class),
      name: L.get(`SkillTree/${b._name}`) ?? b._name,
      description: L.get(`SkillTree/${b._name}Description`) ?? null,
      colour: rgbaHex(b._color),
      icon: queueIcon(b._crest, guidIndex, 'skilltree', cleanKey(b._name)),
      nodes: 0,
    };
    classes.push(entry);
    const guid = readMetaGuid(file);
    if (guid) classByGuid.set(guid, entry);
  }
  classes.sort((a, b) => a.id - b.id);

  const nodes = [];
  for (const { file, doc } of loadDocs(walk(join(root, 'Nodes'), isAsset))) {
    const b = doc.body;
    if (b?._id == null) continue;

    const type = E.named(SKILL_NODE_TYPES, b._type, 'Minor');
    const named = ['ClassHub', 'ActiveSkill', 'Passive', 'Capstone', 'Root'].includes(type);
    const granted = b._grantedSkill?.Id?.Value || b._grantedPassive?.Id?.Value;
    const asset = granted ? quantumIndex.get(String(granted)) : null;
    if (granted && !asset) warn(`skill tree node ${b._id} grants asset ${granted}, which does not resolve`);

    const grants = (b._grants ?? []).map((g) => ({
      stat: E.named(E.StatIndexes, g.Index, 'Max Health'),
      kind: E.named(SKILL_GRANT_KINDS, g.Kind, 'Flat'),
      value: num(g.Value),
    }));

    const key = cleanKey(basename(file, '.asset'));
    const icon = asset
      ? queueIcon(asset.body.Icon, guidIndex, 'skilltree', key)
      : (b._icon?.guid ? queueIcon(b._icon, guidIndex, 'skilltree', key) : null);

    nodes.push({
      id: num(b._id),
      type,
      tier: num(b._tier),
      classKey: classByGuid.get(b._class?.guid)?.key ?? null,
      name: named && b._name ? L.get(`SkillTree/${b._name}`) ?? prettify(b._name) : null,
      description: named && b._name ? L.get(`SkillTree/${b._name}Description`) ?? null : null,
      grants,
      icon: icon ?? statIcons.get(grants[0]?.stat) ?? null,
      // Root and the hubs cost nothing and cannot be bought.
      cost: type === 'Root' || type === 'ClassHub' ? null : {
        level: num(b._unlockLevelRequirement),
        coins: num(b._unlockCoinCost),
        materials: (b._unlockItems ?? []).map((m) => {
          const item = itemsByGuid.get(m.ItemData?.guid);
          return { item: item?.key ?? null, itemName: item?.name ?? null, amount: num(m.Amount) };
        }).filter((m) => m.item),
      },
      points: activation.get(type) ?? 0,
      x: Math.round(num(b._position?.x)),
      y: Math.round(num(b._position?.y)),
      links: decodeLinkedIds(file, warn),
      isEntry: Boolean(num(b._isFirstNode)),
    });
  }

  nodes.sort((a, b) => a.id - b.id);
  assignClasses(nodes, warn);
  addPrerequisites(nodes);
  for (const node of nodes) {
    const owner = classes.find((c) => c.key === node.classKey);
    if (owner) owner.nodes += 1;
  }

  const counts = {};
  for (const node of nodes) counts[node.type] = (counts[node.type] ?? 0) + 1;

  return {
    classes,
    nodes,
    counts,
    // "Minor {[NAME]}" / "Notable {[NAME]}" — the game names a stat node after its
    // first grant, and the sheet already carries the pattern in every language.
    nameTemplates: {
      Minor: L.get('SkillTree/MinorName') ?? 'Minor {[NAME]}',
      Notable: L.get('SkillTree/NotableName') ?? 'Notable {[NAME]}',
    },
    extraClassDiamondCost: num(config._extraClassDiamondCost) || csDefault('_extraClassDiamondCost'),
    skillSlotDiamondCosts: (config._skillSlotDiamondCosts ?? []).map(num).filter((n) => n)
      .length ? (config._skillSlotDiamondCosts ?? []).map(num) : csDefaultList('_skillSlotDiamondCosts'),
    bounds: {
      minX: Math.min(...nodes.map((n) => n.x)),
      maxX: Math.max(...nodes.map((n) => n.x)),
      minY: Math.min(...nodes.map((n) => n.y)),
      maxY: Math.max(...nodes.map((n) => n.y)),
    },
  };
}

/** `{r: 0.44, g: 0.9, b: 1}` -> `#71e5ff`. */
function rgbaHex(colour) {
  if (!colour) return null;
  const byte = (v) => Math.max(0, Math.min(255, Math.round(num(v) * 255))).toString(16).padStart(2, '0');
  return `#${byte(colour.r)}${byte(colour.g)}${byte(colour.b)}`;
}

// ------------------------------------------------------------------ bastion

const cleanKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 1e4) / 1e4;

/**
 * Bastion: three players defend a Nexus in the middle of the map against endless
 * waves. Nothing about it fits the level-based shape the other modes share — there
 * is no authored wave list at all, only the formulas that generate one — so the
 * mode carries its own payload and the site renders it with its own view.
 */
function extractBastion(guidIndex, L, monsters) {
  const configFile = join(ASSETS, 'QuantumUser', 'Resources', 'DB', 'Bastion', 'DefaultBastionConfig.asset');
  if (!existsSync(configFile)) { warn('DefaultBastionConfig.asset not found — Bastion skipped'); return null; }

  const c = readUnityYaml(configFile)[0]?.body;
  if (!c) { warn('DefaultBastionConfig.asset could not be parsed — Bastion skipped'); return null; }

  const statusNames = statusEffectNameIndex();
  const upgrades = extractBastionUpgrades(guidIndex, L, statusNames);

  // The tuning constants, named as the config names them.
  const tuning = {
    upgradeInterval: c.UpgradeChoiceWaveInterval ?? 5,
    bossInterval: c.BossWaveInterval ?? 10,
    firstAssailantWave: c.FirstAssailantWave ?? 5,
    baseBudget: c.BaseBudget ?? 0,
    budgetPerWave: c.BudgetPerWave ?? 0,
    baseStats: fp(c.BaseStats),
    statsPerWave: fp(c.StatsPerWave),
    baseHealth: fp(c.BaseHealthMultiplier),
    healthGrowth: fp(c.HealthGrowthBase),
    playerHealth: (c.PlayerCountHealthMultipliers ?? []).map(fp),
    assailantGrowth: fp(c.AssailantGrowth),
    assailantCurvePower: fp(c.AssailantCurvePower),
    assailantHealth: fp(c.AssailantHealthMultiplier),
    bossStats: fp(c.BossStatsMultiplier),
    bossHealth: fp(c.BossHealthMultiplier),
  };

  const players = 3;
  const playerMultiplier = tuning.playerHealth[
    Math.min(Math.max(players - 1, 0), Math.max(tuning.playerHealth.length - 1, 0))
  ] ?? 1;

  // The same formulas as BastionWaveConfig, which takes a zero-based wave index.
  const curve = (wave) => {
    const i = wave - 1;
    const assailants = i < tuning.firstAssailantWave
      ? 0
      : Math.round(1 + tuning.assailantGrowth * (i - tuning.firstAssailantWave) ** tuning.assailantCurvePower);
    return {
      wave,
      budget: tuning.baseBudget + tuning.budgetPerWave * i,
      statsMultiplier: round2(tuning.baseStats + tuning.statsPerWave * i),
      healthMultiplier: round2(tuning.baseHealth * tuning.healthGrowth ** i * playerMultiplier),
      assailants,
      boss: wave % tuning.bossInterval === 0,
      upgrade: wave % tuning.upgradeInterval === 0,
    };
  };

  const monsterRef = (ref) => {
    // The reference is to the monster's `.qprototype`, whose whole content is the
    // guid of the prefab it wraps — the same indirection buildPrototypeIndex walks.
    let prefab = ref?.guid && guidIndex.get(ref.guid);
    if (prefab?.endsWith('.qprototype')) {
      prefab = guidIndex.get(readFileSync(prefab, 'utf8').trim()) ?? null;
    }
    if (!prefab) return { key: null, name: null, icon: null };
    const prefabName = basename(prefab, '.prefab');
    const key = monsters.byPrefab.get(prefabName);
    const display = key && monsters.display.get(key);
    return {
      key: key && monsters.linkable.has(key) ? key : null,
      name: display?.name ?? prettify(prefabName),
      icon: display?.icon ?? null,
    };
  };

  const pools = (c.EnemyPools ?? []).map((pool) => ({
    element: E.named(E.Elements, pool.Element, 'Neutral'),
    weight: fp(pool.SelectionWeight),
    enemies: (pool.Enemies ?? []).map((entry, index) => {
      const resolved = monsterRef(entry.EntityPrototype);
      return {
        ...resolved,
        // The pool carries its own icon, which is what the in-game wave preview
        // shows; fall back to the monster's own if the field is empty.
        icon: queueIcon(entry.MonsterIcon, guidIndex, 'bastion', cleanKey(resolved.name ?? `enemy_${index}`))
          ?? resolved.icon,
        cost: entry.Cost ?? 0,
        minWave: entry.MinWave ?? 0,
      };
    }).sort((a, b) => a.cost - b.cost || String(a.name).localeCompare(String(b.name))),
  })).sort((a, b) => b.weight - a.weight || a.element.localeCompare(b.element));

  // The authored list repeats one boss; the rotation treats it as a single entry.
  const bosses = [];
  const seen = new Set();
  for (const ref of c.Bosses ?? []) {
    if (!ref?.guid || seen.has(ref.guid)) continue;
    seen.add(ref.guid);
    bosses.push(monsterRef(ref));
  }

  return {
    key: 'bastion',
    name: L.get('GameMode/Bastion') ?? 'Bastion',
    blurb: null,
    icon: destinationIcon('BastionIcon', 'bastion'),
    players,
    kind: 'endless',
    groups: [],
    bastion: {
      // Rounded only on the way out: the milestones above are computed from the
      // exact fixed-point values, so a rounded growth base cannot skew the curve.
      ...Object.fromEntries(Object.entries(tuning).map(([k, v]) => [
        k, typeof v === 'number' ? round4(v) : Array.isArray(v) ? v.map(round4) : v,
      ])),
      players,
      playerMultiplier: round4(playerMultiplier),
      // Wave time is hardcoded in BastionWaveConfig.GetWaveInterval, not authored.
      waveSeconds: 45,
      // Wave 1 and 5, then every tenth up to 100 — one boss wave per row from
      // there on, which is the rhythm a reader is actually pacing against.
      milestones: [1, 5, ...Array.from({ length: 10 }, (_, i) => (i + 1) * 10)].map(curve),
      bosses,
      pools,
      upgrades,
    },
  };
}

/** `NameKey` of every status effect, by Unity guid and by Quantum asset guid. */
function statusEffectNameIndex() {
  const byUnityGuid = new Map();
  const byQuantumGuid = new Map();
  for (const { file, doc } of loadDocs(walk(join(SO, 'StatusEffects'), isAsset))) {
    const b = doc.body;
    if (!b?.NameKey) continue;
    const unityGuid = readMetaGuid(file);
    if (unityGuid) byUnityGuid.set(unityGuid, b.NameKey);
    const quantumGuid = b.Identifier?.Guid?.Value;
    if (quantumGuid) byQuantumGuid.set(String(quantumGuid), b.NameKey);
  }
  return { byUnityGuid, byQuantumGuid };
}

/**
 * The roguelike upgrades offered every few waves. Each level's lines come from the
 * upgrade's own `PopulateEffectsAtLevel`, replayed by lib/bastion.mjs.
 */
function extractBastionUpgrades(guidIndex, L, statusNames) {
  const scripts = readUpgradeScripts(walk(BASTION_UPGRADE_SCRIPTS, (p) => p.endsWith('.cs')), warn);

  // Both reference kinds appear: a Unity guid for a plain asset field, a Quantum
  // asset guid for a reference held inside a prototype.
  const statusNameOf = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (node.guid) return statusNames.byUnityGuid.get(node.guid) ?? null;
    const id = node.Data?.Id?.Value ?? node.Id?.Value;
    return id ? (statusNames.byQuantumGuid.get(String(id)) ?? null) : null;
  };

  const upgrades = [];
  for (const { file, doc } of loadDocs(walk(BASTION_UPGRADE_ASSETS, isAsset))) {
    const b = doc.body;
    if (!b?.Levels) continue;

    // Resolved through m_Script rather than m_EditorClassIdentifier: SharpStrike's
    // stored class name is stale and names a type that no longer exists.
    const scriptPath = guidIndex.get(scriptGuid(doc));
    const className = scriptPath && basename(scriptPath, '.cs');
    const script = className && scripts.get(className);
    if (!script) { warn(`Bastion upgrade ${basename(file, '.asset')} has no readable script — skipped`); continue; }

    const name = className.replace(/^BastionUpgrade/, '');
    const key = cleanKey(name);

    const levels = b.Levels.map((level, index) => ({
      level: index + 1,
      lines: effectsForLevel(script, level, statusNameOf, warn, name).map((line) => {
        const term = `Bastion/Upgrades/${name}/${line.labelKey}`;
        const template = L.get(term);
        if (template === undefined) {
          warn(`Bastion upgrade ${name}: no localized string for ${term}`);
          return null;
        }
        return fillUpgradeLine(template, line.values, warn, `${name}/${line.labelKey}`);
      }).filter(Boolean),
    }));

    upgrades.push({
      key,
      name: L.get(`Bastion/Upgrades/${name}`) ?? prettify(name),
      icon: queueIcon(b.Icon, guidIndex, 'bastion', key),
      rarity: PLAYER_UPGRADE_RARITIES[b.Rarity ?? 0] ?? 'Common',
      category: PLAYER_UPGRADE_CATEGORIES[b.Category ?? 0] ?? 'Offensive',
      maxLevel: levels.length,
      levels,
    });
  }

  upgrades.sort((a, b) => PLAYER_UPGRADE_RARITIES.indexOf(a.rarity) - PLAYER_UPGRADE_RARITIES.indexOf(b.rarity)
    || a.name.localeCompare(b.name));
  return upgrades;
}

// ----------------------------------------------------------- status effects

const STATUS_GROUPS = ['Buff', 'Debuff', 'Neutral'];

/**
 * Status effects, assembled the way the game's tooltip assembles them: numbers
 * from the asset, sentence from localization, and the mapping between the two
 * from the effect's `GetEffectValues` override.
 */
function extractStatusEffects(guidIndex, en) {
  const scripts = readStatusEffectScripts(
    walk(STATUS_EFFECT_SCRIPTS, (p) => p.endsWith('.cs') && !p.endsWith('StatusEffectData.cs')),
    warn,
  );

  const effects = [];
  for (const { file, doc } of loadDocs(walk(join(SO, 'StatusEffects'), isAsset))) {
    const b = doc.body;
    if (!b?.NameKey) continue;

    const assetName = basename(file, '.asset');
    const scriptPath = guidIndex.get(scriptGuid(doc));
    const script = scriptPath && scripts.get(basename(scriptPath, '.cs'));
    if (!script) { warn(`status effect ${assetName} has no readable script — skipped`); continue; }

    // Every `{RawValue: n}` on the asset is an FP the description may reference.
    const fields = new Map();
    for (const [key, value] of Object.entries(b)) {
      if (value && typeof value === 'object' && value.RawValue !== undefined) fields.set(key, fp(value));
    }

    const name = en.get(`StatusEffect/${b.NameKey}`) ?? prettify(b.NameKey);
    const described = describeStatusEffect(
      en.get(`StatusEffect/${b.NameKey}Description`), script, fields, warn, assetName,
    );
    if (!described) warn(`status effect ${assetName} has no description string`);

    effects.push({
      key: b.NameKey.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(),
      name,
      group: STATUS_GROUPS[b.Group ?? 0] ?? 'Neutral',
      icon: queueIcon(b.Icon, guidIndex, 'statuses', b.NameKey.toLowerCase()),
      // A tick rate only means something for effects that actually tick; the rest
      // serialize it as 0.
      tickSeconds: fields.get('TickRate') || null,
      effects: described?.parts ?? [],
    });
  }

  // Buffs first, then debuffs, then the two that are neither, alphabetical inside
  // each group — the same order the tab shows them in.
  effects.sort((a, b2) => STATUS_GROUPS.indexOf(a.group) - STATUS_GROUPS.indexOf(b2.group)
    || a.name.localeCompare(b2.name));
  return effects;
}

// ------------------------------------------------------------------ talents

/**
 * Talents: the asset holds a name key and an icon, the numbers live in the
 * matching C# script, and the localized text has `{[VALUE_1]}` placeholders. All
 * three are joined here so each level reads as a finished sentence.
 */
function extractTalents(guidIndex, en) {
  const scripts = walk(TALENT_SCRIPTS, (p) => /Talent\.cs$/.test(p));
  const values = readTalentValues(scripts, warn);
  const drawOdds = readTalentDrawOdds(TALENT_ODDS, warn);

  const talents = [];
  for (const { file, doc } of loadDocs(walk(join(SO, 'Talents'), isAsset))) {
    const b = doc.body;
    if (!b?._nameKey) continue;

    const script = basename(file, '.asset');
    const parsed = values.get(script);
    if (!parsed) { warn(`talent ${script} has no resolved level values — skipped`); continue; }

    const key = (b._friendlyId || b._nameKey).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const nameTemplate = en.get(`Talent/${b._nameKey}`);
    const descTemplate = en.get(`Talent/${b._nameKey}Description`);
    if (!descTemplate) warn(`talent ${script} has no description string`);

    const levels = [...parsed.levels.keys()].sort((a, b2) => a - b2).map((level) => ({
      level,
      roman: romanNumeral(level),
      description: fillTalentText(descTemplate, parsed.levels.get(level), level),
      // The odds are per rank and identical for every talent, so they ride along
      // on each rank rather than sitting in a table of their own.
      chance: drawOdds?.[level - 1] ?? null,
    }));

    talents.push({
      key,
      nameKey: b._nameKey,
      // The in-game name carries its rank, e.g. "Berserk III"; the wiki lists the
      // talent once and shows the ranks in a table, so the rank marker is dropped.
      name: fillTalentText(nameTemplate, {}, 0)?.replace(/\s*\b[IVX]+\b\s*$/, '').trim()
        || prettify(b._nameKey),
      maxLevel: parsed.maxLevel,
      icon: queueIcon(b.Icon, guidIndex, 'talents', key),
      levels,
    });
  }

  talents.sort((a, b) => a.name.localeCompare(b.name));
  return talents;
}

// --------------------------------------------------------------- game modes

/**
 * The three playable modes, shaped identically so the site renders them from one
 * template:
 *
 *   mode -> groups (a chapter, a dungeon, a raid) -> sets (Normal/Hard, or tiers)
 *        -> levels -> waves -> enemies
 *
 * Only released content is published: Antique Ruins is the one dungeon with a
 * proper `DungeonData` asset listing its tiers, and Shadows Citadel the one raid.
 * The other dungeon assets sit loose in the folder with no definition, so they are
 * work in progress and are skipped by construction rather than by a name list.
 */
function extractGameModes(guidIndex, en, monstersByKey, generators, itemsByGuid) {
  const modes = [];

  const adventure = extractAdventure(guidIndex, en, monstersByKey, generators, itemsByGuid);
  if (adventure.length) {
    modes.push({
      key: 'adventure',
      name: en.get('GameMode/Adventure') ?? 'Adventure',
      blurb: 'The main campaign. Six biomes, each with its own chapter of stages.',
      icon: destinationIcon('AdventureIcon', 'adventure'),
      players: 1,
      groups: adventure,
    });
  }

  const dungeons = extractTieredMode(guidIndex, en, monstersByKey, itemsByGuid, {
    dir: join(SO, 'CombatLevels', 'Dungeons'),
    script: SCRIPT.dungeon,
    nameKeyPrefix: 'Dungeon',
    setLabel: 'Tier',
  });
  if (dungeons.length) {
    modes.push({
      key: 'dungeon',
      name: en.get('GameMode/Dungeon') ?? 'Dungeon',
      blurb: 'Tiered runs that drop accessories. The deeper the tier, the better the roll.',
      icon: destinationIcon('DungeonIcon', 'dungeon'),
      players: 1,
      groups: dungeons,
    });
  }

  const raids = extractTieredMode(guidIndex, en, monstersByKey, itemsByGuid, {
    dir: join(SO, 'CombatLevels', 'Raids'),
    script: SCRIPT.raid,
    nameKeyPrefix: 'Raid',
    setLabel: 'Difficulty',
    difficultyNames: E.Difficulties,
  });
  if (raids.length) {
    modes.push({
      key: 'raid',
      name: en.get('GameMode/Raid') ?? 'Raid',
      blurb: 'A three-player fight. Costs a Raid Key and pays out from shared loot pools.',
      icon: destinationIcon('RaidIcon', 'raid'),
      players: 3,
      groups: raids,
    });
  }

  return modes;
}

/** Adventure chapters, as `groups` in the shared mode shape. */
function extractAdventure(guidIndex, en, monstersByKey, generators, itemsByGuid) {
  const biomeByChapter = new Map();
  for (const gen of generators) if (gen.chapter) biomeByChapter.set(gen.chapter, gen.biome);

  const chapters = [];
  for (const file of walk(join(SO, 'CombatLevels', 'Chapters'), (p) => /Chapter\d+\.asset$/.test(p)).sort()) {
    const b = readUnityYaml(file)[0]?.body;
    if (!b?._nameKey) continue;
    const folder = basename(dirname(file));

    const sets = [
      ['Normal', b.NormalLevels],
      ['Hard', b.HardLevels],
      ['Master', b.MasterLevels],
    ]
      .map(([label, refs]) => ({
        label,
        levels: (refs ?? [])
          .map((ref, index) => readLevel(guidIndex.get(ref?.guid), index + 1, monstersByKey, itemsByGuid))
          .filter(Boolean),
      }))
      .filter((s) => s.levels.length);

    chapters.push({
      key: b._friendlyId || folder.toLowerCase(),
      name: en.get(`Adventure/${b._nameKey}`) ?? prettify(b._nameKey),
      biome: biomeByChapter.get(folder) ?? null,
      setKind: 'Difficulty',
      sets,
    });
  }
  return chapters;
}

/**
 * Dungeons and raids share a layout: one definition asset holding an ordered
 * `Levels` array. A dungeon's entries are tiers; a raid's are difficulties.
 */
function extractTieredMode(guidIndex, en, monstersByKey, itemsByGuid, opts) {
  const groups = [];

  for (const { file, doc } of loadDocs(walk(opts.dir, isAsset))) {
    if (scriptGuid(doc) !== opts.script) continue;
    const b = doc.body;
    const id = b._friendlyId || basename(file, '.asset');

    const levels = (b.Levels ?? [])
      .map((ref, index) => {
        const difficulty = opts.difficultyNames ? opts.difficultyNames[index] : null;
        const level = readLevel(guidIndex.get(ref?.guid), index + 1, monstersByKey, itemsByGuid);
        if (!level) return null;
        level.difficulty = difficulty;
        return level;
      })
      .filter(Boolean)
      // A level with no waves has nothing to fight: the asset exists but the
      // content does not. Ancient Tree and Witch's Castle are shells like this,
      // which is how unreleased locations exclude themselves — fill in the waves
      // and they appear on their own.
      .filter((level) => level.waves.length);

    if (!levels.length) { warn(`${opts.nameKeyPrefix} ${id} has no level with any wave — not released yet, skipped`); continue; }

    groups.push({
      key: id.toLowerCase(),
      name: en.get(`${opts.nameKeyPrefix}/${id}`) ?? prettify(id),
      icon: locationIcon(id),
      biome: null,
      setKind: opts.setLabel,
      sets: [{ label: opts.setLabel, levels }],
    });
  }

  groups.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}

/**
 * Every dungeon and the raid have their own icon, filed under the location's
 * `_friendlyId`. The folder is called Dungeons but holds the raid's icon too.
 */
function locationIcon(id) {
  const file = join(ASSETS, 'Resources_moved', 'UI', 'Icons', 'Dungeons', `${id}.png`);
  if (!existsSync(file)) { warn(`no icon for location ${id}`); return null; }
  return queueIconFile(file, 'gamemodes', id.toLowerCase());
}

function destinationIcon(fileBase, name) {
  const file = join(ASSETS, 'Resources_moved', 'UI', 'Icons', 'Destinations', `${fileBase}.png`);
  if (existsSync(file)) return queueIconFile(file, 'gamemodes', name);
  warn(`${fileBase}.png not found`);
  return null;
}

function readLevel(file, index, monstersByKey, itemsByGuid) {
  if (!file || !existsSync(file)) return null;
  const docs = readUnityYaml(file);

  // Document order is not stable — Normal levels put the CombatLevelData first,
  // Hard levels put the config first — so both are found by content.
  const data = docs.find((d) => d.body?.LevelConfigRef != null)?.body;
  if (!data) return null;

  const wanted = data.LevelConfigRef?.Id?.Value != null ? String(data.LevelConfigRef.Id.Value) : null;
  const config = docs.find((d) => String(d.body?.Identifier?.Guid?.Value ?? '') === wanted)?.body
    ?? docs.find((d) => Array.isArray(d.body?.Waves))?.body;

  return {
    index,
    name: basename(file, '.asset'),
    kind: E.named(E.LevelTypes, data.LevelType, 'Adventure'),
    cost: num(data.Cost),
    costCurrency: E.named(E.RechargeableCurrencies, data.CostType, 'Energy'),
    xp: num(data.Xp),
    monsterXp: num(data.MonsterXp),
    coins: [num(data.CoinMinMax?.x), num(data.CoinMinMax?.y)],
    teamSlots: num(data.ActiveTeamCount) || null,
    accessoryDrop: data.DropAccessory ? accessoryOdds(data.AccessoryDrop) : null,
    itemDrops: data.DropItems ? itemDropPools(data.ItemDrop, itemsByGuid) : [],
    waves: (config?.Waves ?? []).map((wave, i) => ({
      index: i + 1,
      enemies: groupEnemies(wave.Enemies ?? [], monstersByKey),
    })),
  };
}

/**
 * Dungeons do not drop a fixed item: they roll an accessory, picking a tier and a
 * rarity from two separate weighted pools.
 */
function accessoryOdds(drop) {
  const pool = (list) => (list?.m_ProbabilityItems ?? [])
    .filter((p) => p.m_Enabled !== 0)
    .map((p) => ({ value: num(p.m_Value), chance: pct(p.m_BaseProbability) }));

  return {
    tiers: pool(drop?.TierPool).map((t) => ({ tier: t.value, chance: t.chance })),
    rarities: pool(drop?.RarityPool)
      .map((r) => ({ rarity: E.named(E.ItemRarities, r.value, `Rarity ${r.value}`), chance: r.chance }))
      .sort((a, b) => E.ItemRarities.indexOf(a.rarity) - E.ItemRarities.indexOf(b.rarity)),
  };
}

/** Raid loot: named pools, each a weighted list of items with their own amounts. */
function itemDropPools(drop, itemsByGuid) {
  return (drop?.Pools ?? []).map((pool) => ({
    pool: pool.PoolName ?? 'Pool',
    entries: (pool.Pool?.m_ProbabilityItems ?? [])
      .filter((p) => p.m_Enabled !== 0)
      .map((entry) => {
        const item = itemsByGuid.get(entry.m_Value?.Item?.guid);
        if (!item) warn(`raid loot references unknown item guid ${entry.m_Value?.Item?.guid}`);
        return {
        item: item?.key ?? null,
        itemName: item?.name ?? null,
        icon: item?.icon ?? null,
        chance: pct(entry.m_BaseProbability),
        amounts: (entry.m_Value?.Amounts?.m_ProbabilityItems ?? [])
          .filter((a) => a.m_Enabled !== 0)
          .map((a) => ({ amount: num(a.m_Value), chance: pct(a.m_BaseProbability) }))
          .sort((a, b) => a.amount - b.amount),
        };
      })
      .sort((a, b) => (b.chance ?? 0) - (a.chance ?? 0)),
  }));
}

/** Collapse a wave's enemy list into one row per distinct monster/level/type. */
function groupEnemies(enemies, monstersByKey) {
  const { linkable, display } = monstersByKey;
  const grouped = new Map();
  for (const enemy of enemies) {
    const id = `${enemy.EnemyFriendlyId}|${enemy.Level}|${enemy.Type}`;
    if (!grouped.has(id)) {
      const shown = display.get(enemy.EnemyFriendlyId);
      grouped.set(id, {
        monster: linkable.has(enemy.EnemyFriendlyId) ? enemy.EnemyFriendlyId : null,
        name: shown?.name ?? prettify(enemy.EnemyFriendlyId),
        icon: shown?.icon ?? null,
        level: num(enemy.Level),
        type: E.named(E.EnemyTypes, enemy.Type, 'Basic'),
        count: 0,
      });
    }
    grouped.get(id).count++;
  }
  return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name) || a.level - b.level);
}

// -------------------------------------------------------------- cross-links

function link({ items, sets, tables, recipes, monsters }) {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const monsterByLootTable = new Map();
  for (const m of monsters) if (m.lootTable) monsterByLootTable.set(m.lootTable, m);

  for (const table of tables) {
    const monster = monsterByLootTable.get(table.id);
    if (monster) {
      table.monster = monster.key;
      table.icon = monster.icon;
    }

    for (const entry of table.entries) {
      const item = byKey.get(entry.item);
      if (!item) continue;
      item.droppedBy.push({
        table: table.id,
        kind: table.kind,
        source: monster ? monster.name : table.sourceName,
        monster: monster?.key ?? null,
        icon: table.icon,
        biomes: table.biomes,
        chance: entry.chance,
        amounts: entry.amounts,
      });
    }
  }

  for (const recipe of recipes) {
    byKey.get(recipe.output)?.craftedBy.push(recipe.id);
    for (const ing of recipe.ingredients) {
      const item = byKey.get(ing.item);
      if (item && !item.usedIn.includes(recipe.id)) item.usedIn.push(recipe.id);
    }
  }

  for (const set of sets) {
    for (const pieceKey of set.pieces) {
      const item = byKey.get(pieceKey);
      if (item) item.set = set.key;
    }
    if (set.associatedWeapon) {
      const weapon = byKey.get(set.associatedWeapon);
      if (weapon && !weapon.set) weapon.set = set.key;
    }
  }
}

/**
 * The type badges an item carries. Additive, and computed after linking because
 * "material" is defined by how an item is obtained, not by which folder it sits
 * in: anything a monster drops or that comes out of a Material recipe counts, on
 * top of the ones already filed under Materials/.
 *
 * There is deliberately no Premium tag — it described where the asset lives, not
 * what the item is.
 */
function tagItems(items, recipes) {
  const fromMaterialRecipe = new Set(
    recipes.filter((r) => r.category === 'Material').map((r) => r.output),
  );

  for (const item of items) {
    const tags = [];
    if (item.category === 'Weapon') tags.push('Weapon');
    if (item.category === 'Armor') tags.push('Armor');
    if (item.category === 'Tool') tags.push('Tool');

    const isMaterial = item.category === 'Material'
      || fromMaterialRecipe.has(item.key)
      || item.droppedBy.some((d) => d.monster);
    if (isMaterial && !tags.includes('Material')) tags.push('Material');

    item.tags = tags;
  }
}

/**
 * Items nothing in the project points at — no craft, drop, shop product,
 * building cost, quest reward or tutorial step. They exist as assets but are
 * unreachable in game, so the wiki would be advertising content players cannot
 * get.
 *
 * Two kinds of reference have to be checked: most systems store an asset guid,
 * but shop products are serialized as a JSON blob that names items by
 * `_friendlyId`, so a guid-only scan would wrongly condemn everything sold.
 */
function findUnreferencedItems(items, itemFileByKey) {
  const files = REFERENCE_ROOTS
    .flatMap((dir) => walk(join(ASSETS, dir), (p) => /\.(asset|prefab|unity|json)$/.test(p)))
    .filter((p) => !NOT_EVIDENCE.some((r) => r.test(p)));

  const guids = new Set();
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/guid: ([0-9a-f]{32})/g)) guids.add(m[1]);
  }

  const guidByKey = new Map();
  for (const [key, file] of itemFileByKey) {
    const guid = readMetaGuid(file);
    if (guid) guidByKey.set(key, guid);
  }

  let candidates = items.filter((i) => !guids.has(guidByKey.get(i.key)));

  // Second pass, only for what the guid scan did not vouch for: look for the
  // friendly id as a whole word, ignoring the item's own asset.
  candidates = sweepByFriendlyId(candidates, files, itemFileByKey);
  if (candidates.length) {
    const code = REFERENCE_ROOTS.flatMap((dir) => walk(join(ASSETS, dir), (p) => p.endsWith('.cs')));
    candidates = sweepByFriendlyId(candidates, code, itemFileByKey);
  }

  return new Set(candidates.map((i) => i.key));
}

/** Drops any candidate whose friendly id appears in one of `files`. */
function sweepByFriendlyId(candidates, files, itemFileByKey) {
  let remaining = candidates;
  for (const file of files) {
    if (!remaining.length) break;
    const text = readFileSync(file, 'utf8');
    remaining = remaining.filter((item) => {
      if (itemFileByKey.get(item.key) === file) return true; // its own asset proves nothing
      return !new RegExp(`(?<![\\w-])${escapeRe(item.key)}(?![\\w-])`).test(text);
    });
  }
  return remaining;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Remove excluded items and every reference to them, so the site never links to
 * something that is not in the payload.
 */
function pruneExcludedItems({ items, sets, tables, recipes, unreferenced, gamemodes }) {
  const dropped = new Set([
    ...items.filter((i) => EXCLUDED_ITEM_CATEGORIES.has(i.category)).map((i) => i.key),
    ...unreferenced,
  ]);
  if (!dropped.size) return { items, sets, tables, recipes, dropped };

  const kept = items.filter((i) => !dropped.has(i.key));

  for (const table of tables) {
    const before = table.entries.length;
    table.entries = table.entries.filter((e) => !dropped.has(e.item));
    if (table.entries.length !== before) warn(`loot table ${table.id} dropped ${before - table.entries.length} excluded item entr(ies)`);
  }

  const keptRecipes = recipes.filter((r) => {
    if (dropped.has(r.output)) return false;
    if (r.ingredients.some((i) => dropped.has(i.item))) {
      warn(`recipe ${r.id} needs an excluded item — hidden`);
      return false;
    }
    return true;
  });

  // Raid loot can name an item the wiki excludes; keep the name, drop the link.
  for (const mode of gamemodes ?? []) {
    for (const group of mode.groups) {
      for (const set of group.sets) {
        for (const level of set.levels) {
          for (const pool of level.itemDrops) {
            for (const entry of pool.entries) if (dropped.has(entry.item)) entry.item = null;
          }
        }
      }
    }
  }

  const keptSets = sets.filter((s) => !s.pieces.every((p) => dropped.has(p)));
  for (const set of keptSets) {
    set.pieces = set.pieces.filter((p) => !dropped.has(p));
    if (dropped.has(set.associatedWeapon)) set.associatedWeapon = null;
  }

  // Cross-links were built before pruning, so strip anything pointing at a
  // dropped item.
  for (const item of kept) {
    item.usedIn = item.usedIn.filter((id) => keptRecipes.some((r) => r.id === id));
    item.craftedBy = item.craftedBy.filter((id) => keptRecipes.some((r) => r.id === id));
  }

  return { items: kept, sets: keptSets, tables, recipes: keptRecipes, dropped };
}

// --------------------------------------------------------------------- main

/**
 * Everything that depends on the chosen language. Called once per language; the
 * expensive asset indexing and file scanning happen once, outside.
 */
function extractLocalized(L, structural) {
  const { guidIndex, quantumIndex, elementIcons, appearances, generators, resourcePrefabs, spawns } = structural;

  const { items, byGuid: itemsByGuid, fileByKey } = extractItems(guidIndex, L);
  const sets = extractSets(L, itemsByGuid);
  const { tables, byQuantumGuid } = extractLootTables(guidIndex, L, itemsByGuid, spawns, resourcePrefabs);
  const { monsters, hidden, byGuid: monstersByGuid, displayByKey, keyByPrefab } = extractMonsters({
    guidIndex, quantumIndex, en: L, lootByQuantumGuid: byQuantumGuid, appearances, elementIcons,
  });
  const banners = extractSummons(L, monstersByGuid, itemsByGuid);
  const recipes = extractRecipes(itemsByGuid);
  const statuses = extractStatusEffects(guidIndex, L);
  const talents = extractTalents(guidIndex, L);
  const buildings = extractBuildings(guidIndex, L, itemsByGuid);
  const monsterLookup = {
    linkable: new Set(monsters.map((m) => m.key)),
    display: displayByKey,
    byPrefab: keyByPrefab,
  };
  const gamemodes = extractGameModes(guidIndex, L, monsterLookup, generators, itemsByGuid);
  const bastion = extractBastion(guidIndex, L, monsterLookup);
  if (bastion) gamemodes.push(bastion);
  const skilltree = extractSkillTree(guidIndex, quantumIndex, L, itemsByGuid);

  return { items, sets, tables, monsters, hidden, banners, recipes, statuses, talents, buildings, gamemodes, skilltree, itemsByGuid, fileByKey };
}

/**
 * Vocabulary the wiki shows as labels — rarities, elements, biomes, stat names.
 *
 * The payloads keep the project's own identifiers (`Common`, `Volcano`) so that a
 * filter in the URL means the same thing in every language. Only the *label* is
 * translated, and it comes from the game's spreadsheet wherever the game has a
 * term for it; `tools/ui/` covers the handful it does not (`Relic`, item
 * categories, the wiki's own loot "kinds").
 */
function buildLabels(L, ui, vocab) {
  const SHEET = {
    rarity: (v) => `Rarities/${v}`,
    element: (v) => `Bestiary/${v}`,
    // The asset folder is `Volcan`, the enum says `Volcano`.
    biome: (v) => `Biome/${v === 'Volcano' ? 'Volcan' : v}`,
    slot: (v) => `EquipmentSlot/${v === 'Main Hand' ? 'Main' : v}`,
    difficulty: (v) => `Difficulty/${v}`,
    stat: (v) => `Stats/${v.replace(/\s+/g, '')}`,
    station: (v) => `Building/StationTypes/${v.replace(/\s+/g, '')}`,
    currency: (v) => ({
      Coin: 'MonsterInventory/Coin',
      Diamond: 'Arena/Diamond',
      Energy: 'FloatingText/Energy',
      'Raid Key': 'Events/DailyWheel/RaidKey',
      Crest: 'Shop/Crest',
    }[v] ?? null),
    buildingCategory: (v) => (v === 'Resource' ? 'Shop/Resource' : null),
    nodeType: (v) => `SkillTree/${v}`,
  };

  const labels = {};
  for (const [kind, values] of Object.entries(vocab)) {
    labels[kind] = {};
    for (const value of values) {
      const term = SHEET[kind]?.(value);
      labels[kind][value] = (term && L.get(term)) ?? ui[`vocab.${kind}.${value}`] ?? value;
    }
  }
  return labels;
}

/** The distinct vocabulary the payloads actually use, so nothing is guessed. */
function collectVocabulary(p) {
  const uniq = (values) => [...new Set(values.filter((v) => v != null && v !== ''))].sort();
  return {
    rarity: uniq([...E.ItemRarities, ...E.MonsterRarities]),
    element: uniq(E.Elements),
    biome: uniq([...p.tables.flatMap((t) => t.biomes), ...p.monsters.map((m) => m.environment),
      ...p.gamemodes.flatMap((m) => m.groups.map((g) => g.biome))]),
    slot: uniq(p.items.map((i) => i.slot)),
    difficulty: uniq([...p.tables.flatMap((t) => t.spawns.map((s) => s.difficulty)),
      ...p.gamemodes.flatMap((m) => m.groups.flatMap((g) => g.sets.map((s) => s.label)))]),
    station: uniq(p.recipes.map((r) => r.station)),
    currency: uniq([...p.buildings.map((b) => b.purchase.currency),
      ...p.gamemodes.flatMap((m) => m.groups.flatMap((g) => g.sets.flatMap((s) => s.levels.map((l) => l.costCurrency))))]),
    category: uniq([...p.items.map((i) => i.category), ...p.items.flatMap((i) => i.tags), ...p.recipes.map((r) => r.category)]),
    kind: uniq(p.tables.map((t) => t.kind)),
    group: uniq(p.statuses.map((s) => s.group)),
    buildingCategory: uniq(p.buildings.map((b) => b.category)),
    setKind: uniq(p.gamemodes.flatMap((m) => m.groups.map((g) => g.setKind))),
    upgradeCategory: uniq(p.gamemodes.flatMap((m) => (m.bastion?.upgrades ?? []).map((u) => u.category))),
    stat: uniq([...p.sets.flatMap((s) => s.bonuses.map((b) => b.stat)),
      ...(p.skilltree?.nodes ?? []).flatMap((n) => n.grants.map((g) => g.stat))]),
    nodeType: uniq((p.skilltree?.nodes ?? []).map((n) => n.type)),
    enemyType: uniq(p.gamemodes.flatMap((m) => m.groups.flatMap((g) => g.sets.flatMap((s) => s.levels.flatMap((l) => l.waves.flatMap((w) => w.enemies.map((e) => e.type)))))))
  };
}

function main() {
  const started = Date.now();
  console.log('Indexing asset guids…');
  const guidIndex = buildGuidIndex();
  const quantumIndex = buildQuantumIndex();
  const prototypeIndex = buildPrototypeIndex(walk(ASSETS, (p) => p.endsWith('.qprototype')), guidIndex);
  console.log(`  ${guidIndex.size} unity guids, ${quantumIndex.size} quantum assets, ${prototypeIndex.size} entity prototypes`);

  console.log('Reading localization…');
  const { languages, maps } = loadLanguages(join(ASSETS, 'Resources', 'I2Languages.asset'), warn);
  const uiStrings = loadUiStrings(UI_STRINGS, languages.map((l) => l.code), warn);
  console.log(`  ${languages.length} languages (${languages.map((l) => l.code).join(', ')}), ${maps.get('en').size} terms each`);

  console.log('Scanning combat levels…');
  const elementIcons = extractElementIcons();
  const { appearances, generators } = scanCombatLevels();
  const resourcePrefabs = scanResourcePrefabs(guidIndex);
  const spawns = scanResourceSpawns(generators, prototypeIndex, resourcePrefabs);
  console.log(`  ${appearances.size} monsters placed, ${generators.length} resource generators, ${resourcePrefabs.size} harvestable tables (${spawns.size} biome-mapped)`);

  const structural = { guidIndex, quantumIndex, elementIcons, appearances, generators, resourcePrefabs, spawns };

  // English is extracted first: which items the project references nowhere is a
  // property of the project, not of the language, and finding out is expensive.
  console.log('Extracting English…');
  const english = extractLocalized(maps.get('en'), structural);
  console.log('Checking which items the project actually uses…');
  const unreferenced = findUnreferencedItems(english.items, english.fileByKey);
  console.log(`  ${unreferenced.size} referenced nowhere`);

  mkdirSync(DATA, { recursive: true });
  mkdirSync(ICONS, { recursive: true });
  clearStaleData();

  const generatedAt = new Date().toISOString();
  let bytes = 0;
  let counts = null;
  const everything = [];

  for (const { code, name } of languages) {
    const raw = code === 'en' ? english : extractLocalized(maps.get(code), structural);

    link({ items: raw.items, sets: raw.sets, tables: raw.tables, recipes: raw.recipes, monsters: raw.monsters });
    tagItems(raw.items, raw.recipes);
    const pruned = pruneExcludedItems({ ...raw, unreferenced });
    const p = { ...raw, ...pruned };

    const levels = p.gamemodes.flatMap((m) => m.groups.flatMap((g) => g.sets.flatMap((s) => s.levels)));
    counts ??= {
      items: p.items.length,
      sets: p.sets.length,
      lootTables: p.tables.length,
      monsters: p.monsters.length,
      recipes: p.recipes.length,
      summonBanners: p.banners.length,
      buildings: p.buildings.length,
      talents: p.talents.length,
      statuses: p.statuses.length,
      skillTreeNodes: p.skilltree?.nodes.length ?? 0,
      chapters: p.gamemodes.find((m) => m.key === 'adventure')?.groups.length ?? 0,
      gameModes: p.gamemodes.length,
      levels: levels.length,
      waves: levels.reduce((n, l) => n + l.waves.length, 0),
    };

    const meta = {
      generatedAt,
      language: code,
      languages,
      counts,
      strings: uiStrings.get(code),
      labels: buildLabels(maps.get(code), uiStrings.get(code), collectVocabulary(p)),
      summonBanners: p.banners,
      rarities: E.ItemRarities,
      monsterRarities: E.MonsterRarities,
      rarityColors: { item: E.ItemRarityColors, monster: E.MonsterRarityColors },
      elements: E.Elements,
      elementIcons,
      hiddenBosses: p.hidden,
      unreferencedItems: [...unreferenced].sort(),
      // Deduped: the same asset problem is reported once per language pass.
      warnings: [...new Set(warnings)],
    };

    const dir = join(DATA, code);
    mkdirSync(dir, { recursive: true });
    const write = (file, value) => {
      const target = join(dir, file);
      writeFileSync(target, JSON.stringify(value));
      return statSync(target).size;
    };

    let langBytes = 0;
    langBytes += write('items.json', p.items);
    langBytes += write('monsters.json', p.monsters);
    langBytes += write('loot.json', p.tables);
    langBytes += write('recipes.json', p.recipes);
    langBytes += write('sets.json', p.sets);
    langBytes += write('buildings.json', p.buildings);
    langBytes += write('gamemodes.json', p.gamemodes);
    langBytes += write('talents.json', p.talents);
    langBytes += write('statuses.json', p.statuses);
    langBytes += write('skilltree.json', p.skilltree ?? { classes: [], nodes: [], counts: {} });
    langBytes += write('meta.json', meta);
    bytes += langBytes;

    everything.push(p.items, p.monsters, p.tables, p.recipes, p.sets, p.buildings, p.gamemodes, p.talents, p.statuses, p.skilltree, meta);
    console.log(`  ${code} (${name}): ${(langBytes / 1024).toFixed(0)} KB`);
  }

  const siteAssets = copySiteAssets();
  console.log(`  ${siteAssets.length} site assets (${siteAssets.join(', ')})`);

  console.log('Copying icons…');
  const orphans = pruneUnreferencedIcons(everything);
  writeIcons();
  console.log(`  ${iconJobs.size} icons (${orphans} unreferenced dropped)`);

  // Icons are copied after the payloads, so any warning raised while copying is
  // not yet in the meta files that were just written. Rewrite the warnings only.
  rewriteWarnings(languages);

  // After every payload exists, so the hash covers the data too.
  const version = stampAssets();
  if (version) console.log(`  assets stamped ?v=${version}`);

  console.log(`\nRead ${posix(PROJECT)}`);
  console.log(`Wrote ${(bytes / 1024).toFixed(0)} KB of JSON to ${posix(relative(SITE, DATA))}`);
  const unique = [...new Set(warnings)];
  if (unique.length) {
    console.log(`\n${unique.length} warning(s):`);
    for (const w of unique.slice(0, 40)) console.log(`  - ${w}`);
    if (unique.length > 40) console.log(`  … ${unique.length - 40} more (see data/en/meta.json)`);
  }
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/**
 * Remove the payloads of a previous run. Languages live in `data/<code>/`, so a
 * language dropped from the project — or the flat layout this replaced — would
 * otherwise be served forever.
 */
function clearStaleData() {
  for (const entry of readdirSync(DATA, { withFileTypes: true })) {
    const target = join(DATA, entry.name);
    try { rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 60 }); }
    catch (err) { warn(`could not clear old data ${posix(relative(SITE, target))}: ${err.code ?? err.message}`); }
  }
}

/** Patch the final warning list into every meta.json already on disk. */
function rewriteWarnings(languages) {
  const unique = [...new Set(warnings)];
  for (const { code } of languages) {
    const file = join(DATA, code, 'meta.json');
    if (!existsSync(file)) continue;
    const meta = JSON.parse(readFileSync(file, 'utf8'));
    meta.warnings = unique;
    writeFileSync(file, JSON.stringify(meta));
  }
}

main();
