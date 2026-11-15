// Runes and enchantments, read the way the combat maths are: every number is a
// constant in the C#, and anything whose shape has changed is reported rather
// than assumed. Two files hold them — `EnchantmentCatalog.cs` in the simulation
// (what each enchantment does, the sets) and `ItemEnchantments.cs` in the client
// (what a rune rolls, what enchanting costs) — and the game itself treats the
// first as the single source, so the wiki reads it rather than a copy.

import { readFileSync } from 'node:fs';

/** The C# enum member, as the wiki's own stat list spells it. */
function statName(member, statIndexes) {
  return statIndexes.find((s) => s.replace(/\s+/g, '') === member) ?? null;
}

/** `{ a, b, c }` arrays out of a jagged C# initializer, in order. */
function numberRows(source, field, onWarn) {
  const block = new RegExp(`${field}\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\};`).exec(source);
  if (!block) { onWarn(`enchantments: could not read ${field}`); return null; }
  return [...block[1].matchAll(/new\[\]\s*\{([^}]*)\}/g)]
    .map((row) => row[1].split(',').map((n) => Number(n.trim().replace(/f$/, ''))));
}

function constant(source, pattern, label, onWarn) {
  const raw = pattern.exec(source)?.[1];
  if (raw === undefined) { onWarn(`enchantments: could not read ${label}`); return null; }
  return Number(raw);
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/**
 * `{ enchantments, sets, countOdds, levelOdds, … }` in one language, or null when
 * a piece the page is built from is missing.
 *
 * `term(key)` looks a string up in the sheet; `statIndexes` is the wiki's stat
 * vocabulary, so a bonus names its stat the way every other page does.
 */
export function readEnchantments({ catalog, client }, term, statIndexes, onWarn = () => {}) {
  const sim = readFileSync(catalog, 'utf8');
  const ui = readFileSync(client, 'utf8');

  const maxLevel = constant(sim, /const int MaxLevel = (\d+);/, 'the highest level', onWarn);
  const maxPerPiece = constant(sim, /const int MaxPerPiece = (\d+);/, 'the enchantments per piece', onWarn);
  const setPieces = constant(sim, /const int SetPieces = (\d+);/, 'the pieces in a set', onWarn);
  const firstBonus = constant(sim, /const int FirstSetBonusPieces = (\d+);/, 'the first set bonus', onWarn);

  // The top level counts double, which is the whole reason a V is worth hunting:
  // if that stops being true the per-level table below is wrong.
  const worthShape = /Worth\(int level\) => level >= MaxLevel \? MaxLevel \+ (\d+) : level;/.exec(sim);
  if (!worthShape) onWarn('enchantments: Worth() is no longer "the top level counts as one more" — levels are shown as written');
  const topLevelWorth = worthShape ? maxLevel + Number(worthShape[1]) : maxLevel;

  // Hundredths of a percent, so 150 is 1.5% — stated in the file and relied on here.
  if (!/Hundredths of a percent per level/.test(sim)) onWarn('enchantments: PerLevel may no longer be hundredths of a percent');

  const entries = [...sim.matchAll(
    /new\(EnchantmentId\.(\w+), "(\w+)", (\d+), EnchantmentPool\.(\w+)(?:, StatIndexes\.(\w+))?\)/g,
  )];
  if (!entries.length) { onWarn('enchantments: the catalog list could not be read — the tab is skipped'); return null; }

  const trios = new Map();
  const trioBlock = /TrioOf\(EnchantmentId id\) => id switch\s*\{([\s\S]*?)\n\s*\};/.exec(sim);
  for (const line of (trioBlock?.[1] ?? '').split('\n')) {
    const m = /^\s*(EnchantmentId\.\w+(?:\s+or\s+EnchantmentId\.\w+)*)\s*=>\s*(\d+)/.exec(line);
    if (!m) continue;
    for (const id of m[1].split(/\s+or\s+/)) trios.set(id.replace('EnchantmentId.', ''), Number(m[2]));
  }

  const value = (perLevel, level) => Math.round(perLevel * (level === maxLevel ? topLevelWorth : level)) / 100;

  const enchantments = entries.map(([, id, key, perLevel, pool, stat]) => {
    const name = term(`Item/Enchant/${key}`);
    const description = term(`Item/Enchant/${key}Description`);
    if (!name) onWarn(`enchantments: no name for ${key}`);
    if (!description) onWarn(`enchantments: no description for ${key}`);
    return {
      key,
      name: name ?? key,
      // The site fills {value} per level, so the number reads in the local format.
      description: (description ?? '').replace(/\{\[VALUE\]\}/g, '{value}'),
      pool,
      stat: stat ? statName(stat, statIndexes) : null,
      trio: trios.get(id) || null,
      levels: Array.from({ length: maxLevel }, (_, i) => ({
        level: i + 1,
        roman: ROMAN[i + 1] ?? String(i + 1),
        value: value(Number(perLevel), i + 1),
      })),
    };
  });

  // Sets: three raise a stat from two pieces, three have an effect at four.
  const fourPiece = new Set(
    (/IsFourPieceSet\(EnchantmentSetId set\) => set is ([^;]+);/.exec(sim)?.[1] ?? '')
      .split(/\s+or\s+/).map((s) => s.trim().replace('EnchantmentSetId.', '')).filter(Boolean),
  );

  const statSets = [...sim.matchAll(/EnchantmentSetId\.(\w+) => \(StatIndexes\.(\w+), (\d+), (\d+)\)/g)];

  const effectValues = {
    VampireLifesteal: constant(sim, /const int VampireLifesteal = (\d+);/, "Vampire's lifesteal", onWarn),
    BlessedImmunitySeconds: constant(sim, /const int BlessedImmunitySeconds = (\d+);/, "Blessed's immunity", onWarn),
    BlessedImmunityPeriodSeconds: constant(sim, /const int BlessedImmunityPeriodSeconds = (\d+);/, "Blessed's period", onWarn),
    CarapaceShield: constant(sim, /const int CarapaceShield = (\d+);/, "Carapace's shield", onWarn),
    CarapaceShieldSeconds: constant(sim, /const int CarapaceShieldSeconds = (\d+);/, "Carapace's shield period", onWarn),
  };

  // Each set of four fills its own sentence; the client picks the same three
  // numbers, so a set missing here would print a placeholder in game too.
  const fourPieceText = {
    Vampire: { VALUE: effectValues.VampireLifesteal / 100, SECONDS: 0, PERIOD: 0 },
    Blessed: { VALUE: 0, SECONDS: effectValues.BlessedImmunitySeconds, PERIOD: effectValues.BlessedImmunityPeriodSeconds },
    Carapace: { VALUE: effectValues.CarapaceShield / 100, SECONDS: effectValues.CarapaceShieldSeconds, PERIOD: 0 },
  };

  const sets = [];
  for (const [, key, stat, atTwo, atFour] of statSets) {
    sets.push({
      key,
      name: term(`Item/RuneSet/${key}`) ?? key,
      bonuses: [
        { pieces: firstBonus, stat: statName(stat, statIndexes), percent: Number(atTwo) / 100 },
        { pieces: setPieces, stat: statName(stat, statIndexes), percent: (Number(atTwo) + Number(atFour)) / 100 },
      ],
    });
  }
  for (const key of fourPiece) {
    const text = term(`Item/RuneSet/${key}Bonus`);
    if (!text) onWarn(`enchantments: no bonus text for the ${key} set`);
    const fill = fourPieceText[key];
    if (!fill) { onWarn(`enchantments: the ${key} set of four has no known values — skipped`); continue; }
    sets.push({
      key,
      name: term(`Item/RuneSet/${key}`) ?? key,
      bonuses: [{
        pieces: setPieces,
        text: (text ?? '').replace(/\{\[VALUE\]\}/g, String(fill.VALUE))
          .replace(/\{\[SECONDS\]\}/g, String(fill.SECONDS))
          .replace(/\{\[PERIOD\]\}/g, String(fill.PERIOD)),
      }],
    });
  }
  sets.sort((a, b) => a.name.localeCompare(b.name));

  const countOdds = numberRows(ui, 'CountOdds', onWarn);
  const levelOdds = numberRows(ui, 'LevelOdds', onWarn);
  const runeCosts = /RuneEnchantCosts = \{([\d, ]+)\};/.exec(ui)?.[1].split(',').map((n) => Number(n.trim()));

  if (!countOdds || !levelOdds || !runeCosts) { onWarn('enchantments: the rune odds are missing — the tab is skipped'); return null; }

  return {
    maxLevel,
    maxPerPiece,
    topLevelWorth,
    setPieces,
    countOdds,
    levelOdds,
    costs: {
      unlock: constant(ui, /const int UnlockCost = (\d+);/, 'the unlock price', onWarn),
      perTier: runeCosts,
      book: constant(ui, /const int BookStoreCost = (\d+);/, 'the price of keeping a roll in a book', onWarn),
    },
    enchantments,
    sets,
    regenerationSeconds: constant(sim, /const int RegenerationSeconds = (\d+);/, "Regeneration's period", onWarn),
    exhaustionEnergy: constant(sim, /const int ExhaustionEnergy = (\d+);/, "Exhaustion's energy", onWarn),
    maxConditionalReduction: constant(sim, /const int MaxConditionalReduction = (\d+);/, 'the conditional reduction cap', onWarn) / 100,
  };
}
