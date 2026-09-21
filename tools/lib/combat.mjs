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
export function readCombatMath({ stats, status, statusQtn }, balance, onWarn = () => {}) {
  const statsSource = readFileSync(stats, 'utf8');
  const statusSource = readFileSync(status, 'utf8');

  // Defense is only measured against a yardstick for ordinary hits; burn, bleed
  // and the other damage types skip mitigation entirely.
  const mitigates = /DamageTypes\.Default\s*=>\s*GetDamageReductionFactor/.test(statsSource);
  if (!mitigates) onWarn('combat maths: Default damage no longer routes through GetDamageReductionFactor');

  const formula = /return reference \/ \(reference \+ defense\);/.test(statsSource);
  if (!formula) onWarn('combat maths: the mitigation formula is no longer reference / (reference + defense)');

  const math = {
    // Tuning knobs, from the asset.
    attackWeight: fpValue(balance?.AttackWeight),
    defenseReference: fpValue(balance?.DefenseReference),
    damageScale: fpValue(balance?.DamageScale),

    // Constants, from the simulation.
    elementStrong: constant(statsSource, /efficiency = Efficiency\.Strong;\s*elementMultiplier = (FP\._[\d_]+);/, 'the super-effective multiplier', onWarn),
    elementWeak: constant(statsSource, /efficiency = Efficiency\.Weak;\s*elementMultiplier = (FP\._[\d_]+);/, 'the not-very-effective multiplier', onWarn),
    elementCritShift: constant(statsSource, /efficiency = Efficiency\.Strong;[\s\S]*?critChance \+= ([^;]+);/, 'the element crit shift', onWarn),
    elementAccuracyShift: constant(statusSource, /IsStrongTo\(defendingElement\.Element\)\)\s*accuracy \+= ([^;]+);/, 'the element accuracy shift', onWarn),
    resistFloor: constant(statusSource, /resistChance = FPMath\.Max\(resistance - accuracy, ([^)]+)\)/, 'the resist floor', onWarn),
    statusSlots: Number(/array<StatusEffect>\[(\d+)\]/.exec(readFileSync(statusQtn, 'utf8'))?.[1] ?? 0) || null,

    mitigatesDefaultOnly: mitigates,
    formulaIntact: formula,
  };

  if (math.defenseReference == null || math.resistFloor == null) {
    onWarn('combat maths: the core figures are missing — the combat page is skipped');
    return null;
  }

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
