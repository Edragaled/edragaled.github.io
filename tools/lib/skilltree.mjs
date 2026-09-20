// The player skill tree.
//
// Each node is a ScriptableObject holding its own graph wiring, so the tree is
// rebuilt here from 283 assets rather than read from one file.
//
// Two things need care. `_linkedNodesIds` is a Unity-serialized `List<int>`,
// written as a hex byte string (`1400000043000000` = 20, 67) — and some of those
// strings parse as numbers, a few even as scientific notation, so the field is
// read from the raw text and never from the parsed document. And only class hubs
// declare a class: every other node inherits it by walking the links.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export const NODE_TYPES = {
  0: 'ClassHub', 2: 'Minor', 3: 'Notable', 4: 'ActiveSkill', 5: 'Capstone', 6: 'Passive', 7: 'Root',
};

export const GRANT_KINDS = { 0: 'Flat', 1: 'Percent' };

/**
 * `1400000043000000` -> [20, 67]. Little-endian int32s; an empty list is an empty
 * string. Read from the raw file because the value is ambiguous once parsed.
 */
export function decodeLinkedIds(file, onWarn = () => {}) {
  const line = /^\s*_linkedNodesIds:\s*(\S*)\s*$/m.exec(readFileSync(file, 'utf8'));
  if (!line) return [];

  const hex = line[1];
  if (!hex) return [];
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 8 !== 0) {
    onWarn(`${basename(file)}: _linkedNodesIds is not a whole number of int32s — links dropped`);
    return [];
  }

  const ids = [];
  for (let i = 0; i < hex.length; i += 8) {
    const bytes = hex.slice(i, i + 8).match(/../g).reverse().join('');
    ids.push(parseInt(bytes, 16));
  }
  return ids;
}

/**
 * Hand every node the class of the hub it hangs from.
 *
 * `_linkedNodesIds` is directed and means "the nodes I open", so walking it
 * forward from each hub covers that hub's whole branch. The Root sits above the
 * hubs and belongs to none.
 */
export function assignClasses(nodes, onWarn = () => {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const hub of nodes.filter((n) => n.type === 'ClassHub')) {
    const queue = [...hub.links];
    const seen = new Set([hub.id]);
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);

      const node = byId.get(id);
      if (!node) { onWarn(`node ${id} is linked but does not exist`); continue; }
      if (node.type === 'ClassHub' || node.type === 'Root') continue;

      if (node.classKey && node.classKey !== hub.classKey) {
        onWarn(`node ${id} is reachable from both ${node.classKey} and ${hub.classKey} — kept ${node.classKey}`);
        continue;
      }
      node.classKey = hub.classKey;
      queue.push(...node.links);
    }
  }

  const orphans = nodes.filter((n) => !n.classKey && n.type !== 'Root' && n.type !== 'ClassHub');
  if (orphans.length) onWarn(`${orphans.length} skill tree node(s) hang from no class hub: ${orphans.map((n) => n.id).join(', ')}`);
}

/**
 * The prerequisites of a node are its *incoming* links, and it needs them all.
 * Stored alongside the outgoing ones so the site can show either direction.
 */
export function addPrerequisites(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) node.requires = [];
  for (const node of nodes) {
    for (const id of node.links) byId.get(id)?.requires.push(node.id);
  }
}

/** `+145 Max Health`, `+8% Crit Chance` — the game's own `SkillStatGrant.ToString`. */
export function grantLabel(kind, value, statName) {
  // Percent grants are stored in hundredths and floored, never rounded up: the
  // simulation would not grant the extra point.
  const amount = kind === 'Percent' ? `${Math.floor(value / 100)}%` : String(value);
  return `${value < 0 ? '' : '+'}${amount} ${statName}`;
}
