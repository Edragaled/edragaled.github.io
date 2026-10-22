// Mirrors of the C# enums the wiki displays. Kept in one place so a rename in
// the game code has a single obvious place to be reflected here.
// Sources: Quantum.CodeGen.Core.cs, ItemData.View.cs, MonsterData.cs, Recipe.cs

export const ItemRarities = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Relic'];

export const MonsterRarities = ['Common', 'Rare', 'Epic', 'Legendary'];

// The game's own palette, so the wiki matches what players see in the client.
// Items and monsters deliberately use different scales for the same rarity name:
// a Common item is white, a Common monster is green.
// Sources: ItemData.View.cs GetItemColor, SummonPool.cs ItemColor.
const ItemColors = {
  White: '#e8e8e8', Green: '#55ff55', Blue: '#5151f3', Purple: '#9446e2',
  Orange: '#e79a00', Cyan: '#52f5f5', Pink: '#fd54fd', Red: '#f95353', Yellow: '#e7e74d',
};

export const ItemRarityColors = {
  Common: ItemColors.White,
  Uncommon: ItemColors.Green,
  Rare: ItemColors.Blue,
  Epic: ItemColors.Purple,
  Legendary: ItemColors.Orange,
  Relic: ItemColors.Cyan,
};

export const MonsterRarityColors = {
  Common: ItemColors.Green,
  Rare: ItemColors.Blue,
  Epic: ItemColors.Purple,
  Legendary: ItemColors.Orange,
};

export const EquipSlots = {
  '-1': 'None', 0: 'Main Hand', 1: 'Secondary', 2: 'Helmet', 3: 'Chestplate',
  4: 'Boots', 5: 'Ring', 6: 'Necklace', 7: 'Bracelet',
};

export const ToolTypes = { 0: 'None', 1: 'Pickaxe', 2: 'Axe' };

export const Elements = ['Neutral', 'Water', 'Fire', 'Grass', 'Dark', 'Light'];

export const EnemyTypes = ['Basic', 'Elite', 'Boss'];

export const EnvironmentDisplays = {
  1: 'Forest', 2: 'Desert', 3: 'Cave', 4: 'Tundra', 5: 'Swamp', 6: 'Plains', 7: 'Volcano',
};

export const RecipeCategories = ['All', 'Weapon', 'Armor', 'Secondary', 'Consumable', 'Material', 'Tool'];

export const StationTypes = { 0: 'None', 1: 'Workshop', 2: 'Modern Workshop', 3: 'Ascended Workshop' };

export const Currencies = ['Coin', 'Diamond', 'Crest', 'Nexus Fragment'];

export const RechargeableCurrencies = ['Energy', 'Raid Key', 'Arena Ticket'];

export const BuildingShopCategories = ['Main', 'Defense', 'Resource', 'Decoration'];

export const LevelTypes = ['Adventure', 'Dungeon', 'Raid'];

export const Difficulties = ['Normal', 'Hard', 'Master'];

export const StatIndexes = [
  'Max Health', 'Attack', 'Defense', 'Attack Speed', 'Crit Chance', 'Crit Damage',
  'Resistance', 'Accuracy', 'Speed', 'Crit Resistance', 'Damage Reduction',
  'Damage Reflection', 'Lifesteal', 'Heal Taken', 'Cooldown Reduction',
  'Knockback Reduction', 'Knockback Strength',
];

/** Stats stored as a 0..1 fixed-point ratio rather than a flat amount. */
export const PercentStats = new Set([
  'Crit Chance', 'Crit Damage', 'Resistance', 'Accuracy', 'Crit Resistance',
  'Damage Reduction', 'Damage Reflection', 'Lifesteal', 'Heal Taken',
  'Cooldown Reduction', 'Knockback Reduction',
]);

let onUnknown = () => {};

/** extract.mjs hands its warning collector over, once, at startup. */
export const reportUnknownTo = (fn) => { onUnknown = fn; };

export const named = (table, value, fallback = 'Unknown') => {
  if (value == null) return fallback;
  const v = Array.isArray(table) ? table[Number(value)] : table[String(value)];
  if (v == null) {
    // Below the range means "unset" — EquipSlots uses -1, EnvironmentDisplays 0.
    // Above it means the C# enum gained a member this mirror has not been told
    // about, which is the one case worth shouting about.
    const known = Array.isArray(table) ? table : Object.values(table);
    const max = Array.isArray(table) ? table.length - 1 : Math.max(...Object.keys(table).map(Number));
    if (Number(value) > max) {
      onUnknown(`enum value ${value} is not one of [${known.join(', ')}] — shown as "${fallback}"; tools/lib/enums.mjs is out of date`);
    }
  }
  return v ?? fallback;
};
