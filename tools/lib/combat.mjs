// The two numbers players always ask about: how much damage Defense actually
// removes, and whether a debuff lands.
//
// Both formulas live in the simulation, and only their tuning knobs live in an
// asset, so the constants are read from the C# and the knobs from
// `CombatBalanceConfig`. Anything that no longer matches its expected shape is
// reported instead of assumed: a wrong constant here would turn the page into a
// confident lie.

import { readFileSync } from 'node:fs';

/** `FP._0_10 + FP._0_05` -> 0.15, `FP._1_25` -> 1.25, `5` -> 5. Null otherwise. */
function evalFp(expr) {
  const text = String(expr).trim();
  if (/^-?\d+$/.test(text)) return Number(text);

  let total = 0;
  for (const term of text.split('+')) {
    const m = /^(-?)FP\._(\d+)(?:_(\d+))?$/.exec(term.trim());
    if (!m) return null;
    total += Number(`${m[2]}.${m[3] ?? '0'}`) * (m[1] ? -1 : 1);
  }
  return Math.round(total * 1e6) / 1e6;
}

/**
 * Pull one constant out of a source file. `pattern` must capture the expression.
 * A miss is reported and returns null, so the caller can drop the section rather
 * than publish a default nobody verified.
 */
function constant(source, pattern, label, onWarn) {
  const raw = pattern.exec(source)?.[1];
  const value = raw === undefined ? null : evalFp(raw);
  if (value === null) onWarn(`combat maths: could not read ${label} — that figure is not published`);
  return value;
}

/**
 * `{ defenseReference, damageScale, resistFloor, … }`, or null if the pieces the
 * page is built from are not all there.
 */
export function readCombatMath({ stats, status, statusQtn, balanceSource }, balance, onWarn = () => {}) {
  const statsSource = readFileSync(stats, 'utf8');
  const statusSource = readFileSync(status, 'utf8');

  // Defense is only measured against a yardstick for ordinary hits; burn, bleed
  // and the other damage types skip mitigation entirely.
  const mitigates = /DamageTypes\.Default\s*=>\s*GetDamageReductionFactor/.test(statsSource);
  if (!mitigates) onWarn('combat maths: Default damage no longer routes through GetDamageReductionFactor');

  const formula = /return reference \/ \(reference \+ defense\);/.test(statsSource);
  if (!formula) onWarn('combat maths: the mitigation formula is no longer reference / (reference + defense)');

  // The base defense is added to Defense before anything else touches it, and
  // fades quadratically. Both halves are checked: a linear fade, or an addition
  // that moved, would make the published curve wrong exactly where it is steepest.
  const addsBase = /defense \+= balance.GetBaseDefense\(defense\);/.test(statsSource);
  const fadeSource = readFileSync(balanceSource, 'utf8');
  const fade = /remaining = FPMath.Clamp01\(FP._1 - defense \/ BaseDefenseFadeOut\);\s*return BaseDefense \* remaining \* remaining;/.test(fadeSource);
  if (!addsBase) onWarn('combat maths: ComputeDamage no longer adds the base defense — the curve ignores it');
  if (!fade) onWarn('combat maths: the base defense no longer fades quadratically — the curve ignores it');

  const math = {
    // Tuning knobs, from the asset.
    attackWeight: fpValue(balance?.AttackWeight),
    defenseReference: fpValue(balance?.DefenseReference),
    damageScale: fpValue(balance?.DamageScale),
    // Defense everyone counts as having, fading out as real Defense grows: with
    // a fixed yardstick an unequipped fighter would otherwise mitigate nothing.
    baseDefense: fpValue(balance?.BaseDefense),
    baseDefenseFadeOut: fpValue(balance?.BaseDefenseFadeOut),

    // Constants, from the simulation.
    // Two shapes in the wild: the multiplier assigned inline, or returned from a
    // helper that holds the strong-hit numbers. The bounded gap keeps the match
    // from wandering into the weak branch below.
    elementStrong: constant(statsSource, /efficiency = Efficiency\.Strong;[\s\S]{0,240}?(?:elementMultiplier = |return )(FP\._[\d_]+);/, 'the super-effective multiplier', onWarn),
    elementWeak: constant(statsSource, /efficiency = Efficiency\.Weak;\s*elementMultiplier = (FP\._[\d_]+);/, 'the not-very-effective multiplier', onWarn),
    elementCritShift: constant(statsSource, /efficiency = Efficiency\.Strong;[\s\S]*?critChance \+= ([^;]+);/, 'the element crit shift', onWarn),
    elementAccuracyShift: constant(statusSource, /IsStrongTo\(defendingElement\.Element\)\)\s*accuracy \+= ([^;]+);/, 'the element accuracy shift', onWarn),
    resistFloor: constant(statusSource, /resistChance = FPMath\.Max\(resistance - accuracy, ([^)]+)\)/, 'the resist floor', onWarn),
    // Where the scale starts and stops. Without these the page cannot say the one
    // thing readers ask: whether enough Resistance ever means "never".
    resistanceBase: constant(statsSource, /StatIndexes\.Resistance => StatBuilder[^;]*?\.WithBase\(([^)]+)\)/, 'the base Resistance', onWarn),
    resistanceMax: constant(statsSource, /StatIndexes\.Resistance => StatBuilder[^;]*?\.WithMax\(([^)]+)\)/, 'the Resistance cap', onWarn),
    accuracyMax: constant(statsSource, /StatIndexes\.Accuracy => StatBuilder[^;]*?\.WithMax\(([^)]+)\)/, 'the Accuracy cap', onWarn),
    statusSlots: Number(/array<StatusEffect>\[(\d+)\]/.exec(readFileSync(statusQtn, 'utf8'))?.[1] ?? 0) || null,

    mitigatesDefaultOnly: mitigates,
    formulaIntact: formula,
    baseDefenseIntact: addsBase && fade,

    // Resistance stopped being only about debuffs in 1.3: the same roll guards
    // the hostile effects that are not status effects at all.
    resistsHostileEffects: /static bool ResistsHostileEffect\(/.test(statusSource),
  };

  if (math.defenseReference == null || math.resistFloor == null) {
    onWarn('combat maths: the core figures are missing — the combat page is skipped');
    return null;
  }

  // A fade that no longer matches is reported above; the knobs are then dropped
  // rather than applied the wrong way round.
  if (!math.baseDefenseIntact) { math.baseDefense = null; math.baseDefenseFadeOut = null; }

  // The yardstick is a lerp between the fixed reference and the attacker's own
  // attack; at weight 0 it is the reference alone, which makes mitigation depend
  // only on the defender. Saying which of the two is live matters to a reader.
  math.usesFixedReference = math.attackWeight === 0 && math.defenseReference > 0;

  return math;
}

const fpValue = (node) => {
  if (node == null) return null;
  const raw = typeof node === 'object' ? node.RawValue : node;
  return raw == null ? null : Math.round((Number(raw) / 65536) * 1e4) / 1e4;
};
