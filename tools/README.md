# Build notes

Developer notes for this repository. The site itself needs no build step; this is
about the wiki generator in `tools/`.

The wiki is not hand-written: items, monsters, loot chances, recipes, item sets,
buildings, the Adventure chapters, the dungeon and the raid are read out of the Unity project's
ScriptableObjects and entity prefabs on every run. Run all commands from the
repository root, not from `tools/`.

```
PixelChronicles website/       ← this repo IS the website; push it and it deploys
  index.html                     landing page
  terms.html                       privacy-policy.html             > legal, wording preserved verbatim
  contact.html                   /
  404.html
  style.css                      shared theme for the pages above
  CNAME                          www.moonforge-games.com — do not edit
  ads.txt                        AdMob publisher verification — do not edit
  app-ads.txt                    AdMob publisher verification — do not edit
  google4c29c4….html             Search Console verification — do not edit or rename
  .nojekyll                      stops GitHub from running Jekyll over the files
  assets/                        logo, hero art, studio mark (generated)
  wiki/                          the wiki app
    index.html, styles.css, app.js
    data/*.json                  generated
    icons/**/*.png               generated (copied from the project sprites)
  tools/                         the generator — not part of the site
    extract.mjs                  reads the Unity project, writes wiki/ + assets/
    bundle.mjs                   single-file previews
    package.mjs                  zips the site for upload
    lib/unity-yaml.mjs           minimal reader for Unity YAML
    lib/quantum-guid.mjs         resolves Photon Quantum AssetGuid references
    lib/sprite.mjs               sprite refs, incl. sprite-sheet sub-rects
    lib/enums.mjs                mirrors of the C# enums and the rarity palette
```

The marketing pages and the wiki share one palette and type scale, so the site
reads as a single thing even though `/wiki/` is a separate app.

`CNAME`, `ads.txt`, `app-ads.txt` and the `google….html` file are carried over
byte-identical. The two ads files are how AdMob verifies the publisher account,
and the Google one is how Search Console verifies the domain — Google fetches it
at the root by its exact filename and compares the contents literally, so it must
not be renamed, reformatted or wrapped in HTML. Changing or losing any of them
breaks the thing it proves, so they all sit at the domain root.

## Where the Unity project has to be

This repo lives **outside** the game project and only ever reads from it, so it
has to locate it. In order of precedence:

1. `--project <path>` on the command line
2. the `PIXEL_CHRONICLES` environment variable
3. `../PixelChronicles` — a sibling folder, which needs no configuration
4. `..` — in case you ever check this out inside the project

If none of those hold a `Assets/Resources_moved/ScriptableObjects` folder, the
generator says so and lists what it tried instead of failing obscurely.

## Regenerate

Requires Node 18+ (tested on 24). No dependencies, no install step.

```bash
node tools/extract.mjs
```

It reads `Assets/Resources_moved/ScriptableObjects/**`, the monster prefabs under
`Assets/QuantumUser/Simulation/Entities/Monsters/**`, and English strings from
`Assets/Resources/I2Languages.asset`. It writes `wiki/data`, `wiki/icons` and
`assets/`, and **never** modifies the Unity project. A run takes about
10 seconds, most of it the project-wide scan that decides which items are actually
used.

It only writes generated folders, so the hand-written pages (`index.html`,
`terms.html`, `style.css`, …) are never touched.

Re-run it after any balance change and republish — the site has no other source
of truth.

## Preview locally

Served over HTTP — this is the real thing, wiki included:

```bash
npx --yes serve .
```

The landing page and legal pages also open fine straight from the filesystem. The
wiki does not: it fetches its JSON, and browsers block `fetch` on `file://`. For
that, build the self-contained previews:

```bash
node tools/bundle.mjs
```

- `preview.html` — the whole wiki in one file (~0.6 MB), CSS, JS, JSON and all
  315 icons inlined.
- `preview-home.html` — the landing page in one file (~530 KB). Links to the other
  pages stay relative and will not resolve; it is a visual preview only.

Both are throwaway artefacts, not the deployment. Rebuild them after every
`extract.mjs` run, since they embed a snapshot.

## Publish to GitHub Pages

**This folder is the repository.** Push it to `edragaled.github.io` and the site is
live — nothing to copy into place, no build step, no server config. The pages are
plain static files with relative paths, and the wiki routes on the URL hash.

First time only — adopt the existing repository's history instead of overwriting
it. The `reset --soft` is what makes this safe: it points HEAD at the published
commit while leaving every file here untouched, so the next commit is an ordinary
change on top rather than a rewrite. No `--force`, nothing lost.

```bash
git init -b main
git remote add origin https://github.com/edragaled/edragaled.github.io.git
git fetch origin main
git reset --soft origin/main
git add -A
git commit -m "Rebuild site: landing page, shared theme, Pixel Chronicles wiki"
git push origin main
```

Afterwards it is the usual loop:

```bash
node tools/extract.mjs
git add -A && git commit -m "Update wiki data" && git push
```

That gives `https://www.moonforge-games.com/` for the landing page and
`https://www.moonforge-games.com/wiki/` for the wiki.

`CNAME`, `ads.txt` and `app-ads.txt` have to sit at the repository root, which is
why the site is not tucked into a subfolder. `.nojekyll` stops GitHub running
Jekyll over the files — without it, Jekyll silently ignores anything it considers
special.

`tools/` ends up served as static files too. That is harmless — they are inert
`.mjs` text files, and no credentials pass through them — but if you would rather
they were not public, move the folder out and run it from there.

For an upload instead of a push, build a zip of just the published files
(`tools/`, the README and the previews are skipped):

```bash
node tools/package.mjs
```

That writes `moonforge-site.zip` (~625 KB, 339 files). It is written by hand
instead of with PowerShell's `Compress-Archive`, which stores Windows backslashes
in the entry names. The ZIP format mandates forward slashes, and such an archive
unpacks into a single flat directory of files literally named
`icons\items\coal.png` on macOS, Linux and in GitHub's uploader — every asset then
404s.

> If you ever get 404s on icons after a rename, check the case of the filenames.
> Windows is case-insensitive but GitHub Pages is not — the generator clears
> `wiki/icons/` before each run precisely to keep the two in sync.

## Cache busting

`extract.mjs` stamps `?v=<hash>` on the wiki's `app.js` and `styles.css`, hashed from
those two files plus every data payload.

This is not cosmetic. The code and the data it reads are separate downloads, so a
browser can pair a cached `app.js` with freshly published JSON. When the shape of
the data changes, that pairing throws — and only the page using the changed shape
breaks, which looks like a tab that refuses to open while the rest of the wiki works.
It happened for real when Game modes moved from `chapters` to `groups`.

The hash deliberately ignores `generatedAt` in `meta.json`, so a regeneration that
changed nothing does not expire every visitor's cache.

`route()` also has an error boundary: a render that throws now shows a message
telling the reader to hard-reload, instead of silently leaving the previous page up
with the real error only in the console.

## What is included

Scope is deliberately narrow for now. Left out, each easy to switch back on:

| Excluded | Where |
|---|---|
| Accessories (15 items) | `EXCLUDED_ITEM_CATEGORIES` in `extract.mjs` — they are procedurally rolled and deserve their own tab |
| Raid/dungeon bosses (Noxyros, Copper Goliath) | `isRaidExclusiveBoss()` |
| Shiny monster variants | not extracted, to keep them a surprise |
| `Recipes/Unused/**` | skipped in `extractRecipes()` — test recipes |
| `TestEventSummonConfig` | `EXCLUDED_SUMMON_CONFIGS` — development scaffolding |
| `LootTables/Tutorial/**` | `EXCLUDED_LOOT_KINDS` — scripted one-offs, not farmable |
| Items nothing references (21 more) | `findUnreferencedItems()` — see below |
| Event summon banners | skipped in `extractSummons()` — limited-time, so not static data |
| Non-purchasable buildings | `extractBuildings()` — ruins repaired in place, not bought |
| Bastion, PvP and Arena modes | exist in the project but are not extracted yet |
| Unreleased dungeons | a location with no waves anywhere excludes itself — see below |

## What the data means

- **Monster stats** are the level‑1 values on the entity prefab, before the
  per-level and per-difficulty multipliers a stage applies. Values a variant does
  not override are inherited from `Monster base.prefab`, and the generator follows
  that chain.
- **Drop chances** are listed per difficulty (Normal / Hard / Master) exactly as
  stored on the loot entry. The **Amount** column is the RNGNeeds weighted
  distribution, e.g. `1 (80%), 2 (20%)`.
- **Only items the project actually uses are published.** An item is kept when
  something points at it — a recipe, a loot table, a building cost, a shop product,
  a quest, a tutorial step. Two kinds of reference have to be followed: most systems
  store an asset guid, but shop products are serialized as a JSON blob naming items
  by `_friendlyId`, so a guid-only scan would wrongly condemn everything on sale.
  Twenty-one items survive nowhere and are dropped (Ninja Katana, Demon Sword,
  Long Dao, the Crusader and Savage armour sets, boss materials like Cyclops Eye
  and Werewolf Fur, …); the full list is `unreferencedItems` in `meta.json`.
  Two exclusions matter for correctness: `UnityDB.prefab` is the Quantum asset
  registry and lists *every* asset, so counting it makes everything look used; and
  content the wiki already treats as dead (`Recipes/Unused/`, tutorial loot tables,
  `PlayerBot.prefab`'s loadout) must not vouch for an item either. Both are in
  `NOT_EVIDENCE`.
- **Item type tags are additive and behaviour-based.** `Material` is not "sits in
  the Materials folder": it is anything a monster drops or that a Material recipe
  produces, on top of the folder. There is no `Premium` tag — that described where
  an asset lives, not what the item is; item bags, shards, candies and totems
  therefore carry no type tag and are reachable only under **All**.
- **Only released content appears under Game modes.** A location is published when at least one
  of its levels has waves. Ancient Tree, Witch's Castle, Cursed Pyramid and Frosted Prison have
  `DungeonData` assets but no waves anywhere, so they exclude themselves — fill the waves in and they
  show up with no code change. Antique Ruins (9 tiers) and Shadow's Citadel (Normal/Hard) are the two
  that qualify today.
- **Dungeons roll an accessory rather than dropping an item.** `AccessoryDrop` holds two independent
  weighted pools, one for the tier and one for the rarity, and both are published per tier.
- **Raid loot comes from named pools.** `ItemDrop.Pools` is a list of pools, each a weighted list of
  items that each carry their own amount distribution. Shadow's Citadel has a main pool and a rare pool.
- **A wave can show a monster that has no wiki page.** The two hidden raid/dungeon bosses still appear
  in their own waves, with their name and icon but no link, because the encounter is real even though
  the monster is not listed.
- **Wave roles (Basic / Elite / Boss) are read but never published.** The same
  monster is Basic in one stage and Elite in another — the label describes the
  encounter, not the monster. Their only use is spotting raid bosses: a monster is
  hidden when *every* appearance is a Boss role *and* none is in a story chapter,
  which separates the raid/dungeon bosses from the chapter bosses players farm.
  Inside a wave the type *is* published, precisely because there it belongs to the
  encounter.
- **Buildings are the purchasable ones only**, using the game's own test from
  `BuildingBuyCostTitleDataProvider`: `!StartsAtLevelZero && BuyBuildingCost != null`.
  That leaves out Workshop, Shop, Portal and Monster Altar, which start as ruins on
  the island and are repaired rather than bought. `BuildingCosts` is indexed by
  level − 1, so entry 0 is the purchase and the rest are upgrades.
- **Adventure levels: document order in the asset is not stable.** Normal levels
  serialize `CombatLevelData` first, Hard levels serialize the `CombatLevelConfig`
  first, so both documents are located by content (`LevelConfigRef` for the data,
  the referenced asset guid for the config). Reading `docs[0]` silently reported
  every Hard level as 0 energy / 0 XP / 0 coins.
- **Appearing in no wave does not mean unavailable.** Six monsters (Tyrios, Anubis,
  Werewolf, Tetranos, Lunadrya, Ophidia) are obtained purely by summoning, so wave
  data alone would misrepresent them. Availability comes from the summon configs:
  `SummonConfigData` → `SummonPools` → each pool's monster list. 41 of the 42
  monsters are summonable; only Lunar Bear is in no pool, and its `Obtainable` flag
  is false too, so that is consistent.
- **No summon rates are extracted, by design.** Which banners and which rarity pool
  carry a monster is recorded; the odds are not. Rates are retuned with every banner
  (and some events are handled specially), and the client already shows them — a
  copy here would go stale silently. The monster page points players at the in-game
  banner instead. If you ever do want them, they are `m_BaseProbability` on the pool
  entry × the same field on the monster inside the pool.
- **Sixteen monsters have no personal loot table** and drop through their stage's
  reward pool instead, which is why their loot section is empty.
- **Resource biomes** cannot be read off the resource: several biomes share one
  prefab (all ores live in a single `Rocks/` folder) and several prefabs share one
  loot table (every tree variant drops from `Tree_LootTable`). The authority is the
  per-biome, per-difficulty `ResourceGenerator`, so the wiki walks
  generator → EntityPrototype → prefab → loot table. Coal Ore correctly comes out
  as all six biomes.
- **A resource's icon is `WorldResource.ResourceIcon`**, not the scene renderer's
  sprite. For trees, cacti and swamp trunks the renderer points at one cell of an
  animation sheet, so serving that PNG would show every frame at once. Chests
  declare no `ResourceIcon` of their own and inherit it from `Chest.prefab`, so the
  variant chain is followed.
- **Sprite-sheet cells are cropped in the browser, not re-encoded.** When a sprite
  reference is not `fileID: 21300000` it is one cell of a sheet; the sub-rect comes
  from the texture's `.meta` (keyed by `internalID`, with y flipped from Unity's
  bottom-left origin to CSS's top-left) and ships as `{ src, crop }`. The site sizes
  a clipping box to the cell's aspect ratio and offsets an oversized image inside
  it, all in percentages, so it stays correct at 22 px in a table and 84 px on a
  detail page. Five sources need this today; items and monsters use whole textures.
- **Rarity colours are the game's own**, lifted from `ItemData.View.cs` and
  `SummonPool.cs`. Items and monsters use different scales for the same name: a
  Common item is white, a Common monster is green. Text has to be shifted off those
  hues for contrast, and that mixing is done in **oklab**, not srgb: srgb blending
  pulls Rare's blue and Epic's purple toward the same pale lavender until they are
  indistinguishable. Keep `--rarity-mix-amount` low for the same reason — every
  extra percent buys contrast and spends hue separation.
- **Skill numbering** comes from the skill asset's name (`Tyrios_Skill_3`), not its
  index in the prefab array — Noxyros has `_Skill_5` at index 2. Skill 3 is the
  monster's special.
- **Item keys** are `_friendlyId` (`iron_sword`), not the display name — the five
  rarities of Ring/Necklace/Bracelet all share the localization key `Ring`, so the
  name cannot identify an item.
- **Fixed-point numbers** (attack speed, set bonuses) are Photon Quantum `FP`
  values, decoded as `RawValue / 65536`.

## Resolving Quantum references

A reference like `LootTable.Id.Value: 534217536395022092` is a Quantum
`AssetGuid`; that number appears nowhere near the asset it points at.
ScriptableObjects store their own in an `Identifier` block, so those are read
directly. Prefab EntityPrototypes do not: each prefab has a sibling
`<Name>EntityPrototype.qprototype`, and the AssetGuid is a deterministic hash of
*that* file's Unity guid, reimplemented in `lib/quantum-guid.mjs`.

The hash is verified against every `Identifier` in the project — 1278 of 1279
match. The remaining one has a manual guid override in `QuantumEditorSettings`,
which is why a stored `Identifier` always wins over a computed hash.
`AssetGuid.ReservedBits` lives in `Quantum.Engine.dll`; its value
(`0x4000000000000000`) was recovered by diffing computed against stored guids.

## Eleven languages, one data set each

`wiki/data/<code>/` holds a complete set of payloads per language — `en`, `fr`,
`es`, `pt`, `th`, `ja`, `ru`, `ko`, `zh`, `de`, `vi`, whatever `I2Languages`
declares. A visitor downloads only their own language, so the transfer is the same
as it was when the wiki was English-only; the repository is about 3.8 MB of JSON
instead of 340 KB, which nothing cares about.

The alternative — one structural payload plus a translation overlay — was rejected
on purpose. Descriptions like "+30% Total Attack" and "Starts with 60% Energy" are
*assembled* from a template and a number, so an overlay would have to re-run that
assembly, and any field forgotten in the overlay map would silently show English
inside a translated page. Extracting per language makes that class of bug
impossible: the whole pipeline runs again, and the language is just an argument.

The expensive work — indexing 17k asset guids, scanning combat levels, finding
which items the project references nowhere — is language-independent and happens
once, so eleven languages cost about 11s instead of 6s.

### Identifiers stay English, labels get translated

A payload keeps the project's own identifiers: `rarity: "Common"`,
`biome: "Volcano"`, `category: "Weapon"`. Only the *label* is translated, through
`meta.labels`. That is what keeps `#/items?rarity=Legendary` meaning the same thing
in every language — a filter in a shared URL must not break because the reader
switched language.

Labels come from the game's spreadsheet wherever the game has a term, which is
most of them: `Rarities/*`, `Bestiary/*` for elements, `Biome/*`,
`EquipmentSlot/*`, `Difficulty/*`, `Stats/*`, `Building/StationTypes/*`. Currencies
are scattered (`MonsterInventory/Coin`, `Arena/Diamond`, `FloatingText/Energy`,
`Events/DailyWheel/RaidKey`), so those are an explicit map rather than a formula.

### The wiki's own text lives in tools/ui/

The game has no wiki, so nothing in the spreadsheet says "Where it drops" or
"Toughest monsters". Those ~200 strings are in `tools/ui/<code>.json`, one file per
language with identical keys. **They were not translated by a human and are not in
your spreadsheet** — edit them there if any wording is off.

`en.json` is the reference. A key it has and another language lacks is reported and
falls back to English; a key only another language has is reported as a likely
typo; and a `{placeholder}` dropped in translation is reported too, because a lost
placeholder renders as a literal `{n}` on the page.

Nothing else is translated: the marketing and legal pages at the repository root
are English only. Terms and a privacy policy are not something to machine-translate.

## The combat page publishes formulas, not numbers

Two figures decide every fight, and both live in the simulation rather than in an
asset, so `lib/combat.mjs` reads the constants out of the C# and the tuning knobs
out of `CombatBalanceConfig`.

**Mitigation.** `damage *= reference / (reference + defense)`. The yardstick is
`Lerp(DefenseReference, attackerAttack, AttackWeight)`, and the asset currently
sets `AttackWeight: 0`, so the yardstick is the fixed `DefenseReference` (400)
and mitigation depends only on the defender. That is worth knowing before reading
the page: at `AttackWeight: 1` it reverts to the historical
`attack² / (attack + defense)`, where the same Defense is near-immunity against a
weak attacker and worthless against a strong one — and the page then says so
instead, through a different string.

Only `DamageTypes.Default` goes through mitigation at all; burn, bleed and poison
skip it. `DamageReduction` is separate and applies last, with a floor of 1 damage.

**Resistance.** `resistChance = max(Resistance − Accuracy, 0.15)`. Only debuffs
roll: buffs are never resisted, they are blocked by Malediction instead, and
Immunity blocks debuffs before any roll. The 15% floor is why no debuff is ever
guaranteed.

The extractor checks the *shape* of both formulas, not just their constants — if
`GetDamageReductionFactor` stops returning `reference / (reference + defense)`, or
`Default` stops routing through it, the run warns. A page of confidently wrong
arithmetic is worse than no page.

### Calculators must capture their elements before rendering

`route()` moves a fragment's children into the document, which leaves the fragment
empty. A handler that calls `root.getElementById` *later* finds nothing and throws
on the first slider move — which is exactly how the first version failed, silently,
with the page looking fine. Look every element up once, while the fragment is still
whole; the references stay valid after the move.

## The skill tree is rebuilt from 283 separate assets

There is no tree asset. Every node is its own ScriptableObject holding its grants,
its price, its position and its outgoing links, so the graph is reassembled from
all of them. Two things need care.

**`_linkedNodesIds` must be read from the raw text.** It is a Unity-serialized
`List<int>` written as a hex byte string — `1400000043000000` is 20 then 67,
little-endian. Several of those strings are also valid numbers, and ten of them
parse as *scientific notation*, so taking the value from the parsed document
silently corrupts the graph. `lib/skilltree.mjs` reads the line itself.

**Only class hubs declare a class.** Every other node inherits it, and the links
are directed — they mean "the nodes I open" — so walking them forward from each
hub covers that hub's whole branch. A node reachable from two hubs, a link to a
node that does not exist, or a node hanging from no hub at all is reported.

The links being directed also means a node's prerequisites are its *incoming*
links, and it needs them all. That is why the page says so in its rules rather
than drawing arrows: the map would be unreadable at 283 nodes and 360 edges.

### The map is drawn at the authored positions

`_position` is real layout data, so the SVG is the tree as the game draws it —
Warden above, Gladiator bottom-right, Enchanter bottom-left, Origin near the
middle. Shape carries the type where no label fits: a diamond is a notable, a
square an active skill, a circle everything else.

Stroke widths and radii are in graph units, and the graph is about 4000 units
wide. Anything under ~8 units of stroke vanishes once it is scaled into the
column, which is exactly what the first version did.

### Names, labels and generated titles come from the sheet

Named nodes use `SkillTree/<name>` and its `Description`. Minor and notable
nodes have no authored name: the game builds one from their first grant using
`SkillTree/MinorName` / `SkillTree/NotableName` (`"Notable {[NAME]}"`), and the
wiki fills the same template, so a French reader sees the same "Def (notable)"
they see in game. The type labels are `SkillTree/<Type>` too; only `Root` has no
term and lives in `tools/ui/`.

Percent grants are stored in hundredths and **floored**, never rounded up — the
simulation would not grant the extra point.

Two prices — the extra-class cost and the skill-slot costs — are absent from
`SkillTreeConfig.asset` because they were added to the class after it was last
written. Unity therefore falls back to the C# field initializers, so the
extractor reads those from `SkillTreeConfig.cs` when the asset is silent.

## Bastion has no authored waves

Every other mode is a list: chapters hold levels, levels hold waves, and the
extractor reads them. Bastion holds none of that. `DefaultBastionConfig` holds the
*formulas*, and the run generates its waves from them, so the wiki reproduces the
formulas instead of listing content that does not exist:

- budget `BaseBudget + BudgetPerWave × waveIndex`, spent on enemies from one pool;
- enemy stats `BaseStats + StatsPerWave × waveIndex`;
- enemy HP `BaseHealthMultiplier × HealthGrowthBase^waveIndex × playerMultiplier`;
- assailants `round(1 + AssailantGrowth × (waveIndex − FirstAssailantWave)^AssailantCurvePower)`.

`waveIndex` is zero-based, which is why "assailants from wave 11" comes out of
`FirstAssailantWave: 10`. The milestone table is computed at 3 players from the
exact fixed-point values; the tuning numbers shown beside it are rounded only on
the way out, so a rounded growth base can never skew the curve. Wave length is not
authored at all — `GetWaveInterval()` returns a hardcoded 45.

### The 22 upgrades describe themselves through their own code

Each upgrade asset holds a `Levels[]` array of a struct that is *different for
every upgrade*, and the mapping from those fields to localized lines lives in the
upgrade's `PopulateEffectsAtLevel`. `lib/bastion.mjs` reads that method and replays
it: which lines a level shows (`if (level.Defense != 0)`, `if (level.X.Data.IsValid)`,
`foreach (var e in level.…)`), which field fills which `{[PLACEHOLDER]}`, and in
which of the three formats. It also resolves `var` aliases, class constants like
`_healthRatioThreshold`, and the two labels built from a status effect's own
`NameKey`.

`UpgradeValue.Seconds` **truncates** (`value.AsInt`) where `Percent` rounds; the
wiki does the same, so `7.5s` reads as `7s` in both.

Asset-to-script is resolved through `m_Script`, not `m_EditorClassIdentifier`:
SharpStrike's stored class name is stale and names a type that no longer exists.

### Two upgrade lines are wrong in the project, not in the wiki

Both are reported as warnings every run rather than papered over:

- **`ElementalBreak/IgnoreDamageReduction`** — the localized string is
  "Ignore {[VALUE]} of the target's defense…", but the code adds that effect with
  no `Values` at all, so nothing can fill `{[VALUE]}`. Either the string should
  drop the placeholder or the effect should pass the value.
- **`Hunter` traps** — the label is built from the applied status effect's
  `NameKey`, which is `Bleed`, but the only matching term is
  `Bastion/Upgrades/Hunter/BleedDecrease`. So the bleed line has no string and is
  left out. Renaming the term to `Hunter/Bleed` fixes it.

## Status effect descriptions are assembled, not stored

No string in the project reads "+30% Total Attack". Three pieces make it:

1. the asset holds the number (`AttackIncreaseMultiplier: {RawValue: 19661}` = 0.30);
2. localization holds the sentence (`{[ATTACK]} Total Attack`);
3. the effect's `GetEffectValues` override says which field fills `{[ATTACK]}` and
   which of the four formats to use.

`lib/status-effects.mjs` reads the override and reproduces `EffectValue.FormatValue`
character for character, so the wiki's numbers read exactly like the in-game
tooltip. The asset's value always wins over the C# field initializer; a field
missing from the asset falls back to the initializer *and* warns, because Unity
should have serialized it.

Two consequences worth knowing:

- **`PercentNoPlus` prints a plus.** In `StatusEffectData.FormatValue`,
  `PercentNoPlus => $"+{IntValue}%"` while `Percent` only adds the sign when the
  value is positive — the names are the wrong way round. It is used for
  damage-over-time magnitudes, so Burn reads "Damage for +1% of Max HP". The wiki
  copies this rather than quietly disagreeing with the game.
- **Descriptions separate clauses with a double space**, which the wiki splits into
  a bullet per clause. Collapsing that spacing in localization would merge them
  back into one run-on line.

## Talent numbers come out of C#

Talents are the one section whose values are not in the project's data. A talent
asset holds only `_nameKey` and an icon; the per-level numbers are `level switch`
expressions in `QuantumUser/Simulation/AssetTypes/Talents/*Talent.cs`, and the
localized string has `{[VALUE_1]}` placeholders the client fills in at runtime.

`lib/talents.mjs` reads the getters, matches them to placeholders through
`GetLocalizationParams`, and evaluates arms that are either a plain integer or a
sum of `FP` constants (`FP._0_20 + FP._0_10 + FP._0_05` → 0.35 → 35%). Anything
else is reported as a warning and the talent is skipped rather than guessed — a
wrong number in a wiki is worse than a missing one. Some switches carry a
defensive `0 =>` arm; talents start at rank 1, so level 0 is dropped.

This makes talents the section most likely to go stale quietly: rebalancing them
is a code change, so re-run the extractor after touching those scripts.

### The rank odds come from the title data provider

35 / 35 / 15 / 10 / 5 for ranks I–V. They are not in an asset either:
`Core/Editor/TitleData/TalentTitleDataProvider.cs` builds them in C# and uploads
them as the `TalentConfig` title data, and the server rolls a rank against them
(`TalentConfig.GetRandomTalent` in the Azure Functions). Reading the provider is
what keeps the published odds in step with what actually gets uploaded.

The talent itself is drawn uniformly — the provider sends nothing but the count,
so the server has nothing else to weight by. **But the server draws it with
`random.Next(0, TalentCount - 1)`, and `System.Random.Next`'s upper bound is
exclusive**, so with 8 talents it only ever returns 0–6. Index 7 in the
`TalentDB` order is `TimingTalent`, which therefore cannot currently be rolled at
all. The wiki publishes the intended `1 / count`, not the off-by-one, because the
fix is one character and publishing "Timing: 0%" would be wrong the moment it
lands.

`Talent/Shatter` exists in localization with no matching asset, so it is not
listed.

## Known data gaps

`wiki/data/meta.json` carries a `warnings` array from the last run. Currently one:

- `Monsters/Desert/DesertTree_LootTable` is a harvestable resource filed under
  `LootTables/Monsters/`. Being indexed under `WorldObjects/WorldResources` settles
  what it really is, so the wiki lists it as a resource and warns. Moving the asset
  into `LootTables/Resources/` would silence it.

Ones the run no longer reports:

- `RawRuby` used to warn about a missing sprite. The item asset itself is no longer
  in the project, so it simply stopped being extracted — item count went 143 → 142.
- `Unused/MoonlightSwordRecipe` lists an ingredient guid that no longer resolves;
  excluded with the rest of `Recipes/Unused/`.
- `LunarBear`'s passive skill asset has no icon assigned; the skill renders without
  one.

These are inconsistencies in the project, not extraction failures.

## Adding a section

The current scope is items, monsters, loot and crafting, in English. The project
also holds quests (254), combat levels/chapters (123), shop entries, buildings,
talents, summons and status effects, plus eleven languages in `I2Languages.asset` —
all reachable with the same parser, and combat levels are already being scanned for
monster roles and resource generators. To add one:

1. Find the C# type's `m_Script` guid and add it to `SCRIPT` in `extract.mjs`.
2. Write an `extractX()` that walks its folder and maps the fields.
3. Emit a `data/x.json`, load it in `boot()`, and add a route + render function.

## Security note

`Assets/Resources/I2Languages.asset` stores the Google Sheets web-service URL and
sync password in clear text. The generator reads only the term list and the English
column, so neither value can reach the published site. That secret is still in the Unity
project, though — worth rotating.
