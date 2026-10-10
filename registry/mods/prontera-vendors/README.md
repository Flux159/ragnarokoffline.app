# prontera-vendors

A living player market on Prontera's main road, for a world with few or no
other players. Fake players run vending stalls on the inner sidewalks and
buying stores on the outer ones. They price things like a real server's
market, undercut each other, sell out, pack up and make room for others, so
the street keeps changing while you play.

Every vendor is a population-engine shell: a real character with a real
MC_VENDING stall or buying store, not an NPC dressed as one. You click it,
browse and trade exactly as you would with a player.

## What it needs

- **The population engine switched on:** Settings → Population → Fake
  players. Its vending economy (`population_engine_vending_enable`) must be
  on, which is the default.
- **App 1.4.5 or later.** The mod uses mod vendor markets, buying stores, the
  `population_vendor_*` script commands and `@vendorinfo` from that build. On
  an older build no stall appears, and the server log names what it doesn't
  know.

## Where

| Lane | What stands there |
|---|---|
| Inner sidewalks, x=147 and x=164, north (y=136–173) | Sell stalls, filled first |
| Inner sidewalks, x=147 and x=164, south (y=52–111) | Sell stalls, then these |
| East of the fountain, rows y=125 and y=110 (x=172–207) | Sell stalls, last |
| Outer sidewalks, x=140 and x=171 (y=136–172) | Buying stores, filled first |
| West of the fountain, rows y=125 and y=110 (x=104–135) | Buying stores, then these |

Stalls fill one lane at a time, in the order above, each opening near a
stall already there (sometimes leaving a cell free), the way players crowd
into a street that is already busy. Once a lane holds its share of the
stalls it has room for (**Stall density**, 80 % by default), the next stall
goes to the following lane, so a busy lane keeps a few natural gaps; a lower
density leaves wider gaps and spreads the stalls over more lanes. When every
lane has its share, the rest go to whichever lane is least full. No stall
stands within 3 cells of an NPC, the same rule a player's own shop follows.
On an app build without the density setting (1.5.6 and older) each lane
fills to 70–80 %; on one older than lane filling, stalls spread at random
over all their lanes instead.

The engine's own Prontera vendors keep spawning exactly as they would
without the mod; these are extra.

## Settings (Settings → Mods)

The mod's **Settings…** button opens its own page: every setting below,
grouped, with the customer rate tables beside the pace settings (they
follow the pace as you change it), Save, Save and restart, and Reset to
defaults. On an app without settings pages they show in the Mods tab.

| Setting | Default | What it does |
|---|---|---|
| Sell shops | on | Off removes every sell stall. |
| Sell stalls | 30 | The most sell stalls that stand on their lanes (0–100), in the evening; fewer at other hours. |
| Buy shops | on | Off removes every buying store. |
| Buy stalls | 30 | The most buying stores that stand on their lanes (0–100), in the evening; fewer at other hours. |
| Minutes before a stall changes | 120 | How long a vendor stays before packing up. Each varies by up to half either way, and stalls are checked once a minute, so short values run long (2 means roughly 1–5 minutes). 0 keeps them until the server restarts. |
| Stall density (%) | 80 | How full a lane gets before stalls open in the next one (20–100). Lower leaves gaps and uses more lanes. Needs an app newer than 1.5.6. |
| Price level (%) | 100 | Every price × this / 100, for sell stalls and buyers alike. Nothing goes below what an NPC pays. |
| Vendors respect the population limit | on | Off: stalls spawn even when the fake-player limit is reached (they still count toward it). |
| Vendors shout their wares | on | Stalls call out a real item and price now and then ("S> Elunium 13K", "B> Oridecon 9500"). |
| Seconds between a stall's shouts | 180 | Average per stall (each waits ½× to 1½×); no two stalls shout within 6 seconds of each other. |
| Customers buy from your stalls | off | Customers for the stalls you open. |
| Customers' pace (%) | 100 | How often they come. |
| Sellers fill your buying stores | off | Sellers for the buying stores you open. |
| Sellers' pace (%) | 100 | How often they come. |
| Customers come while the server is off | on | Restored @autotrade stalls get the downtime (up to 48 h). |
| Dynamic market | off | Prices react to trades and news, then drift back (see below). |
| Market strength (%) | 100 | How hard a trade moves a price. |
| Price recovery (hours) | 72 | After this long, half of a move has faded. |
| Market news | on | About once a week an event moves a group of items for a few days, shown on the board. |
| Announce market news | on | The server announces each event's start and end, and War of Emperium's moves. Off: the board only. |
| Hunted supply | off | What only monsters drop sells only once simulated hunters have found it (see below). |
| Hunting parties | 20 | How much they hunt on an average hour, in full parties' worth. |
| How long loot stays (days) | 5 | Half-life of what reached the market; what players use up 0.5x, equipment 3x, cards and MvP loot 5x. |
| Start with a filled market | off | Off: a new market starts empty and fills as the hunters go. On: it starts where it would settle. |
| MvP kills (per MvP a day) | 1 | The most times a day each MvP dies; 0 for none. |

Settings take effect when the server starts.

## Sell stalls

118 themes. Each time a spot gets a stall (at server start, after a rotation
or after a sell-out) it rolls a theme, so over a session the whole range
comes through:

- **Staples, always up:** general goods, potions, forge supplies, healing
  items, common cards and rare cards (at least one each, at most two).
- **Goods:** slim potions, gemstones, Ygg/Ori/Elu, skill supplies, ammo,
  magic scrolls, dyestuffs (every sign says so), taming items, elemental converters, Undershirt +
  Pantie, Bloody Branches, OBB/OPB, OCA/MCA.
- **Cards:** besides the two staples, binders by slot (weapon, armor,
  headgear, garment and shoes, shield, accessory) and a cheap-cards stall.
  Never MVP cards. Card stalls are twice as likely as other themes.
- **By class:** Knight, Crusader, Wizard, Sage, Hunter, Bard/Dancer, Priest,
  Monk, Assassin, Rogue, Blacksmith, Alchemist, Taekwon/SG/SL, Ninja,
  Gunslinger, Super Novice, Doram: gear that class wears and few others can.
- **By weapon type:** daggers, swords, two-handers, spears, axes, maces,
  staves, bows, books, knuckles, instruments and whips, guns, huuma.
- **By armor slot:** garments, footgear, shields, body armor, slotted gear,
  headgear, accessories, costumes.
- **Pets:** pet eggs with incubators and food, and pet equipment. An egg
  bought from a stall arrives as a real, hatchable egg: the server creates
  it for you at the moment you buy it.
- **Specials:** starter gear, low- and mid-level weapons, katars, elemental
  daggers (forged Fire/Water/Earth/Wind, some "Very Strong"), crimson
  weapons, shadow gear, a stall that sells nothing but an Ice Pick, rare
  collectibles, a "hunter's haul" of popular drops.
- **Carded:** carded weapons, carded armory (body, shield, garment, shoes,
  headgear) and carded accessories: the builds iRO players really listed
  (from ragnastats: "+7 Triple Critical Jur", "Thara Frog Guard", "Clip of
  Zerom"), weighted by how often, plus a few messed-up cardings sold cheap.
  Class stalls carry their guide builds (iRO wiki) and carded pieces that
  class wears; refined-weapon and slotted-gear stalls carry some too. A
  carded piece costs its item, refines and cards, plus a little for the
  work. Never MVP cards.
- **Refined:** weapons from their safe limit to three past it, armor +4 to
  +7, priced by what it costs to make, including failed attempts past the
  safe limit.
- **Loot:** one stall per dungeon (Byalan, Geffenia, Kiel, Payon Cave, Orc
  Dungeon, Ant Hell, Sphinx, Pyramids, Sunken Ship, Clock Tower, Glast Heim,
  Turtle Island, Toy Factory, Niflheim, Magma, Ice Cave, Abyss Lake,
  Thanatos, Odin, Juperos, Bio Lab, Comodo, Amatsu, the Culverts, the Guild
  Dungeon), loot by monster level (1–20 up to 81–99), mini-boss loot and MVP
  items. Each loot stall skips what dozens of monsters drop, so it shows its
  own place.
- **Random:** five stalls that each sample a broad pool: monster loot,
  consumables, equipment, cheap junk ("Cart Clearance") and a mixed bag.

Every other theme stands at most once at a time. Shop signs mix theme names
with the vague titles real stalls use ("Stuff", "SALE", "Happy hunting!",
"..."), taken from a sample of 500 iRO shops, and two stalls never show the
same sign (a repeat gets a number: "ores n more 2"). A sign that offers goods
("SALE", "cheap stuff") only ever hangs over a stall that sells; buyers get
their own ("WTB", "B> paying well"), and now and then a cheeky one ("B> your
mom", "WTB> a happy life"). Stalls of mixed goods (general goods, the
hunter's haul and the random stalls) get cheeky sell signs too ("S> my
sanity, cheap", "S> definitely not stolen"); a stall of one kind of thing
always says what it sells.

A sign that names items ("S> OBB OPB", "B> ori elu", "B> Soldier Skeleton
loot") only goes up over a stall that really has them, and some signs name
an item and price straight from the stall's stock: "S> Elunium 13k", "B>
Sticky Mucus 450z". These need an app build with the matching population
engine (`StockTitles`); on an older one, stalls show only the signs that
name no item, so a sign never lies either way.

A stall that sells out packs up within a minute, as a player would, and
another takes the spot.

## Buying stores

About 70 themes, most of them buying what you bring home from hunting:

- **Always there:** two buyers of upgrade ores (Elunium, Oridecon, Rough
  Elunium, Rough Oridecon, Emveretarcon), and one each for crafting
  materials (Steel, Iron, Iron Ore, Coal, Star Crumb), elemental stones and
  converters, herbs, alchemy and brewing materials (Witched Starsand, Empty
  Bottle, Poison Spore, Medicine Bowl and more), berries (Strawberry, Grape,
  Honey, the SP food no NPC sells) and junk: the drops nearly every monster
  leaves (Sticky Mucus, Zargon, Jellopy, Garlet, Cyfar, Shell...).
- **Dungeon buyers:** one per dungeon, about 38: "Buying Byalan loot",
  "WTB> Thor's Volcano loot", "B> Soldier Skeleton loot". Each wants what that
  dungeon's monsters drop most, weighted by how many of them spawn, so a Payon
  Cave buyer asks for Skel-Bones and Decayed Nails, not a rare drop.
- **Leveling-field buyers:** the fields players farm, where the loot has
  buyers on real servers: the spore fields (Strawberries, spores), Payon
  Forest (Horns, Acorns, Resin), the Sograt desert (Grit, Fine Sand, Frills),
  the Orc fields, Kokomo Beach, the Geffen, Juno, Einbroch and Rachel fields,
  and the fields of the EXP-quest NPCs. Their signs name the place and its
  monster, from that era's own spawns: the Sograt buyer is "B> Scorpion
  loot" in renewal and "B> Hode loot" in pre-renewal.
- **Quests:** turn-ins for the repeatable EXP quests and the Eden Group's
  collecting missions (Fluff, Grit, Huge Leaf, Rusty Screw...), anything
  several NPC quests ask for, and dyestuffs.
- **The rest:** rare cards (never the low-level ones: those you sell at a
  stall), OCA/MCA/OBB/OPB and branches, Ygg items, potions, other
  consumables, gemstones, loot by monster level (six bands), and a random
  buyer.

Dungeon and field buyers together hold a little over half the spots that
rotate; each stands at most once at a time.

- A store wants 2–5 kinds of item (rAthena's limit) and only items rAthena
  allows in buying stores, so never equipment. (Pre-renewal rAthena does not
  allow Jellopy, so no buyer there takes it.)
- Buyers of loot, turn-ins, herbs, berries and alchemy materials pay 75–95 %
  of the low end of the item's sell price; the rest (cards, boxes, Ygg,
  gems, ores...) pay 60–85 %. Either way it is less than any stall asks and
  never less than an NPC pays.
- It wants lots of cheap loot and a few of anything valuable.
- It packs up when it has bought everything or spent its zeny.
- Anyone can open a buying store, so buyers wear any class's sprite and gear.

## Customers for your own stalls

Two settings, both off by default, bring the street's customers to the
stalls *you* open (needs the app build whose population engine has them; on
an older one they do nothing):

- **Customers buy from your stalls.** Open a vending stall as usual (a
  Merchant-class skill, as on any server), online or on `@autotrade`, and
  customers buy now and then. You get the zeny less the vending tax and the
  usual "sold" message, as if a player bought.
- **Sellers fill your buying stores.** Open a buying store and players
  bring loot to it: common drops often, rare ones seldom.

What decides a sale:

| | Effect |
|---|---|
| Your price vs the market (the price list's range) | under an NPC's price: snapped up; under market: faster; at market: steady; 1.5x: rare; 2x: never |
| Your buying-store offer vs the market | above market: eager; near it: steady; a lowball: rare; no more than an NPC pays: never |
| Demand (`BuyersPerDay`, `SellersPerDay` in the price list) | what fake buyers want and quests ask for sells best; sellers come as often as monsters drop the item |
| A fake stall on the map selling it cheaper (or buying it dearer) | half as many customers, a third if it is more than 5 % better |
| The map | Prontera in full, anywhere else 75 % |

How often they come, at 100 % pace in Prontera and a fair price (every line
is checked once a minute; under market more often, over it far less):

| Your stall sells | Customers a day | About one every |
|---|---|---|
| Items fake buyers want (Elunium, Strawberry, their loot) | 36-75 | 20-40 minutes |
| Other everyday items | about 12 | 2 hours |
| Equipment, cards | 6-9 | 3-4 hours |
| Dear items (100k+, 1M+) | x0.6, x0.3 | slower still |

| Your buying store wants | Sellers a day | About one every |
|---|---|---|
| Common loot (Jellopy, Sticky Mucus) | 72 | 20 minutes |
| Uncommon drops | 18-36 | 40-80 minutes |
| Rare drops | 3-6 | 4-8 hours |
| MVP-only items | never | |

A customer takes 1-5 (cheap items 5-50), so a fairly priced stack of 30
Elunium sells in about three hours. The generator's `DEMAND_SCALE` sets this
base; the pace settings scale it per server. **Customers' pace** and **Sellers' pace**
scale all of it: 200 % twice as often, 50 % half.

**While you are away.** An `@autotrade` stall keeps trading. With
**Customers come while the server is off** on, a restart also gives it the
customers of the time the server was down (up to 48 hours). The Merchant
Guild mails you (RODEX) what your stall or store did while you were away:
after a start, when it sells out or closes, and every six hours.

**For GMs:** `@vendorinfo customers` lists the player stalls on your map
with each line's market price, price factor and expected customers a day,
and how long the last pass took; `@vendorinfo customers ff <minutes>`
fast-forwards them.

## A street that follows the clock

Every hour on the hour the street changes with the time of day, as on a real
server: **Sell stalls** and **Buy stalls** are the most that stand, from 19:00
to 22:59. Early evening (17–18) has 95 % of them, late evening (23) 90 %,
the night a core of AFK merchants (80 %), the afternoon 85 % and the
morning the fewest (70 %). Stalls past the count pack up; more open as the
evening comes. Shouts follow too: **Seconds between a stall's shouts** is
the early-evening pace, a little faster later in the evening, somewhat
slower in the day (slowest in the morning), a third as often at night. The
server's own clock decides.

## A dynamic market

**Dynamic market** (off by default) makes prices follow the market, then drift
back to the price list:

- **Trades move them.** Buying from the stalls drives a price up; selling to
  the buyers drives it down; your own stall's and buying store's trades nudge
  it. How far depends on how much of the item changes hands each day: at 100 %
  strength, selling 30 Elunium to the buyers lowers it about 5 %, 3 Angeling
  Cards about 12 %, 500 Jellopy hardly at all.
- **Related items move together**: about a third of a move spills over to
  their group (Elunium and Oridecon and their rough stones, herbs, potions,
  gemstones, Ygg items, boxes and albums, dragon parts...).
- **War of Emperium**: when WoE starts, potions, gemstones and bottles (the
  War of Emperium season's items) go up 10–20 % at once and drift back like
  any move. With **Announce market news** on the server announces its start
  and end.
- **Market news** (optional) moves a group for a few days about once a week:
  War of Emperium season, refining fever, a hat-making craze, a card craze, an
  Alchemist Guild order, gambling night, a pet fair, a monster raid on
  Prontera, a blight on the World Tree, a fashion contest, an arrow shortage,
  the Sages' elemental research, bounty week (prices up); an orc rampage, a
  spore harvest, a Glast Heim purge, a dragon hunt, a merchant clearance,
  smith overstock, a collector selling off his cards, an ore strike in
  Mjolnir, a herb bloom (down); a festival (food up, junk down); and monsters
  migrating between dungeons (one's loot down, another's up): 31 in all. With
  **Announce market news** on (the default) the server announces each one as
  it starts and again when it ends ("[Prontera Market] Monsters raid
  Prontera's gates..."); off, only the board shows it.
- **Prices drift back**: after **Price recovery** hours (72 by default) half
  of any move has faded. Time the server is off counts too. Prices stay
  between half and twice the price list.
- **Everyone uses the moved price**: stalls price their stock at it when they
  open, buyers offer at it, and your customers judge your prices by it. A
  buyer still always pays less than a stall asks.
- **The market board** at Prontera (131, 218) lists the news and the five
  items rising and falling most.
- **For GMs**: `@market` lists the movers; `@market <item>` shows one item;
  `@market news` lists the events and `@market news <event>` starts one now;
  `@market reset` puts every price back.

How it works: it is all this mod's own NPC script
(`npc/prontera-vendors-market.txt`). Once a minute it reads the server's own
trade log (`picklog`, vending and buying-store rows of real players), keeps
each item's index in its own server variables, fades it every ten minutes,
and sets `$@pop_item_pct[<item id>]`, which the population engine applies to
this mod's prices. The groups, the news and each item's daily volume are
generated into `npc/prontera-vendors-market-data.txt` by the build script
(`MARKET_GROUPS`, `market_events`, `market_volume`).

## A hunted supply

**Hunted supply** (off by default) ties what the sell stalls hold to what the
world's hunters find. Without it every stall rolls its stock from its theme
as if the supply never ran out; with it, an item that only monsters drop is
on the street only while someone has found one and nobody has bought it yet.

- **Hunters roam the world, in groups as on a real server.** Solo players
  (60 %, about 100 kills an hour), duos and trios (25 %, about 225) and full
  parties (15 %, about 400). **Hunting parties** counts full parties'
  worth of hunting (300 kills an hour each), so 20 means about 34 groups on
  an average hour: fewer at night, more in the evening and at weekends.
  Each group hunts a field or dungeon near its level for 1 to 4 hours, then
  moves on: solo players spread over every map, full parties go mostly to
  the known spots. A map nobody has hunted in a while draws them more and
  more (up to 8x after a week), so none is left out. About 370 maps in
  renewal, 300 in pre-renewal. Loot comes as a steady trickle from all
  over, with a burst now and then where a party farms.
- **By the spawns and the drop rates.** A group's kills are shared out by
  how many of each monster spawn, and never faster than a
  monster respawns: a mini-boss with a one-hour timer drops at most once an
  hour. Drops follow each monster's drop table times the server's own drop
  rates (`item_rate_*`), so a 10x server gets a 10x market.
- **MvPs** die a few times a day at most: when one is up, its chance an hour
  falls with its level (Baphomet 15 %, Thanatos far less), and it never dies
  more than **MvP kills** times a day (once by default) or faster than it
  respawns. Its loot and rewards roll like any drop.
- **Stock leaves again.** Every hour some of each item is bought by "other
  players": after **How long loot stays** days half of it is gone. What
  players use up (ores, elemental stones, herbs, alchemy materials,
  potions) goes in half that time; equipment lasts three times as long,
  cards and MvP loot five times. Stock
  settles where what comes in matches what leaves; each item also has a cap
  (four times the most a stall lists, at least 5), so junk doesn't pile up.
- **Scarcity sets prices.** Every hour each item that settles at two or
  more copies is priced by its stock: up to 25 % dearer as it runs out, up
  to 15 % cheaper at twice its settled stock, for stalls and buyers alike.
  With the dynamic market on this multiplies into its prices, so the board
  shows it; without it, it is the only move. A rarer item (most cards and
  gear) is simply there or not, and keeps its price.
- **Your trades count.** Buying from a stall takes from the supply; selling
  into a buying store puts it back on the market, where it decays like
  anything else. A buyer still pays less than a stall asks, so selling and
  buying back never pays.
- **While the server is off** the parties keep hunting: at start the last 48
  hours of the gap are hunted an hour at a time (a few hours a beat, so the
  server doesn't stall), and anything older moves each item toward where it
  would settle in one step.
- **What it limits:** items a sell stall lists plain (no refine, forge or
  cards) that monsters on those maps drop, that no NPC sells at about the
  market price (up to 1.5x) and that players can't make. Potions, NPC ores,
  forged, refined and carded gear, pet eggs and anything the hunters can't
  find stay as they are. A stall whose theme has nothing in stock doesn't
  open; another theme takes the spot.
- **Fewer sellers while stock is low.** Every hour the number of sell stalls
  follows how much of a settled market's variety is in stock (each item up
  to one copy, so a pile of Elunium is not a full market): 30 % of **Sell
  stalls** with nothing in stock, rising to all of them once the market
  has settled.
  Stalls past the count pack up; buying stores are not affected.

At the defaults (20 parties, 5 days, 1x rates) about 48 Elunium and 11
cards a day reach the market; about 170 Elunium and 270 cards in all are on
it once it has settled. A rare card settles below one copy: it shows up now
and then, and is gone again. A new market starts empty and fills as the
parties hunt: loot reaches about half its settled level in one half-life
(5 days by default), cards and equipment take five and three times as long.
**Start with a filled market** puts a new market at the settled level at
once, and so does `@supply reset filled`.

**Needs:** app 1.5.2 or later for the mod store (on an older build only this
part is left out), and the build whose population engine reads
`$@pop_item_supply` (app 1.5.4) for the stalls to follow it; on 1.5.2 and
1.5.3 the parties hunt but the stalls stock as before.

**For GMs:** `@supply` shows the groups out, the last MvP and what is in
stock; `@supply <item>` one item's stock, cap and where it settles;
`@supply hunt <hours>` hunts that many hours now; `@supply reset [empty |
filled]` starts the supply over (empty by default).

**Starting the whole market over:** Settings → Mods → prontera-vendors →
**Reset data…** wipes the supply, and at the next start the dynamic market's
prices and news go back to the price list with it (`@market reset` does that
part alone). The game restarts, so every stall opens fresh. The first start
with the hunted supply on does the same once, since it can't tell a reset
from a first time.

How it works: `npc/prontera-vendors-supply.txt` runs it once a minute and
once an hour, keeps the ledger in the mod store (`docs/MOD_STORE.md`) and
sets `$@pop_item_supply[<item id>]` (supply + 1) for every item it limits;
the population engine lists no more than that on this mod's stalls between
them. Its data, `npc/prontera-vendors-supply-data.txt` (each map's yield per
party-hour, the MvPs, each item's half-life class and cap), is generated by
the build script (`write_supply_script`, `SUPPLY_*`).

## Prices

Prices follow kRO's player market, which is cheaper and steadier than old
iRO's (Elunium ~13k rather than ~263k) and suits a solo world better. Where
each price comes from, in order:

1. **kro:** the 90-day median asking price on kRO's official servers, from
   RagMAYA (ragmaya.kr), where at least 3 listings back it.
2. **ragnastats:** iRO's average from ragnastats.com, converted to kRO's
   scale with a factor per kind of item, learned from items both price.
3. **npc:** an NPC's price, for gear an NPC sells. A stall never asks more
   than an NPC does for the same item.
4. **sibling:** a same-named item's price (Knife → Knife [3]).
5. **estimate:** a model's ballpark from what the item is, which monsters
   drop it, how rarely, and its level and stats. Typically within ×2.5
   either way, so worth checking.

Items none of these can price have no price and are never sold.

A few prices are set in the generator rather than taken from a market
(`PRICE_SET` in `build_vendors.py`, `set` in the price list):

| Item | Renewal | Pre-renewal |
|---|---|---|
| Old Card Album | 900,000 – 1,100,000 | 600,000 – 750,000 |
| Mystical Card Album | 2,700,000 – 3,300,000 | 1,800,000 – 2,250,000 |

An Old Card Album sells for about what the card it rolls is worth on average
on this price list, under the 2.5M the Eden market NPC asks; a Mystical Card
Album, a shot at the rare cards, for three OCAs.

Each item has a `[min, max]` range, and every stall rolls inside it. Half the
time an item is listed 1–5 % under the cheapest rival stall on the map, but
never below its range. Nothing goes below what an NPC pays for it, so
nothing can be flipped for profit, except the rare "fat-finger": 1 in 5000
per item, a price with a digit missing.

### Changing prices

`db/population_vendor_prices/prontera-vendors.csv` is the price list: one row
per tradeable item, `Id,Name,Min,Max,Source`. Open it in Excel or any
editor, change what you like and restart the server; it wins over the prices
in the YAML, for sell stalls and buyers. The Id decides; the Name is there to
find things, and `;` works as the separator too. `0,0` means "no price yet".

Refined, forged and carded lines keep the price in `population_vendors.yml`,
since a +9 isn't priced like a plain one. The file only prices this mod's
vendors.

## For GMs

- `@vendorinfo` lists every mod stall on your map: owner, place, theme, sign,
  item count and minutes to rotation.
- `@vendorinfo <theme or market>` shows a theme's stock and price ranges, or a
  market's themes and how many of each are up. The last part of a key is
  enough: `@vendorinfo byalan`, `@vendorinfo refine`, `@vendorinfo sidewalks`.

## Pre-renewal

A pre-renewal server gets its own set from `pre-re/db/` (`"prerenewalFolder"`
in mod.json lays it over `db/`): the same themes where the items exist,
without the renewal-only ones (costumes, shadow gear, Crimson weapons,
Doram), with its own price list.

Its stalls and buyers list only what a pre-renewal server hands out.
rAthena's pre-renewal item database also holds what came with renewal and
later (third-job gear such as the Mechanic's devices, runes, spell books and
poison herbs, Bradium and Carnium, cash-shop and event items, slotted
variants nothing drops), and nothing in pre-renewal gives those to a player.
The build script keeps an item only if it has a source there:

- a monster that is out there drops it (a spawn, a script's spawn, a dead
  branch's summon, a slave, a castle's treasure chest);
- an NPC sells it or a script gives it (quests, exchanges, socket enchants);
- players make it (forging, brewing, cooking, arrow crafting), or it belongs
  to a pet;
- a box that is itself obtainable holds it.

About 2,600 of the 4,550 tradeable items in the pre-renewal database pass.
The renewal set is not filtered.

## How it's built

`db/population_vendors.yml`, `db/population_vendor_pop.yml`, the price list
and the pre-renewal set are **generated** from rAthena's item, monster, pet
and spawn databases and two price caches. The tools live outside the mod in
[`registry/tools/prontera-vendors/`](../../tools/prontera-vendors/), so
players don't download them:

```
python3 registry/tools/prontera-vendors/build_vendors.py                   # rebuild from the caches
python3 registry/tools/prontera-vendors/build_vendors.py --era pre-re      # the pre-renewal set
python3 registry/tools/prontera-vendors/build_vendors.py --refresh-prices  # fetch iRO prices the cache lacks
python3 registry/tools/prontera-vendors/build_vendors.py --reprice         # rebuild the price list from the data
python3 registry/tools/prontera-vendors/scrape_ragmaya.py --workers 12     # refresh kRO prices (resumable)
python3 registry/tools/prontera-vendors/scrape_carded.py --adjectives      # iRO's card prefixes (once)
python3 registry/tools/prontera-vendors/scrape_carded.py                   # carded builds iRO players sold (resumable)
```

Themes are defined in `build_vendors.py`: a hand list, a rule over the item
database, "what these dungeons' monsters drop", or, for buyers, a place
(`AREAS_LOOT`, `BUY_ONLY_DUNGEONS`, `FIELD_SPOTS`). A re-run keeps
rows of the price list you changed by hand (marked `manual`); everything else
follows the data. The YAML can be edited by hand for a quick test, but a
re-run overwrites it.

How the YAML works:

- **The first two entries are the markets.** Each has `Spawns` (map, areas,
  Count, `Fill: Lanes`) and `Themes` (each with `Weight`, `Min`, `Max`). The
  areas are the lanes, filled in the order listed (`AREAS` and `BUY_AREAS` at
  the top of the generator).
- **The settings override some of it.** The Sell stalls and Buy stalls
  settings replace each market's Count.
- **Each theme is a `Type: Pool` vendor.** Its fields are `PickCount`,
  `MaxSlots`, `TitleFromPool` (`{name}` is the vendor's name), rotation,
  `PriceMistakeOneIn`, `Undercut` and `Callouts`. Buyers have
  `Buying: true`.
- **Each Pool line** has `Amount` and `Price: [min, max]`, and optionally
  `Refine`, `Element`, `Stars` and `Cards`.

## Known gaps

- Vendors use the engine's generated names, not player-style handles.
- When a stall rotates or sells out, a new vendor takes the spot rather than
  the same one restocking.

## Files

```
registry/mods/prontera-vendors/
├── mod.json                         settings
├── README.md
├── images/                          icon and screenshot
├── npc/
│   ├── prontera-vendors.txt         hands the settings to the engine
│   ├── prontera-vendors-customers.txt  the customer settings, for the engine
│   ├── prontera-vendors-market.txt     the dynamic market, its board and @market
│   ├── prontera-vendors-market-data.txt  its groups, news and item volumes (generated)
│   ├── prontera-vendors-supply.txt     the hunted supply and @supply
│   ├── prontera-vendors-supply-data.txt  its maps, yields and MvPs (generated)
│   ├── prontera-vendors-newer.txt   the settings that need app 1.4.5
│   └── prontera-vendors-density.txt the stall density, for an app newer than 1.5.6
├── db/
│   ├── population_vendors.yml       markets + themes (generated)
│   ├── population_vendor_pop.yml    one vendor profile per theme (generated)
│   └── population_vendor_prices/
│       └── prontera-vendors.csv     the price list; edit freely
└── pre-re/db/                       the pre-renewal set, same layout

registry/tools/prontera-vendors/     the generator, kept out of the mod
├── build_vendors.py
├── estimate.py                      the estimate model
├── scrape_ragmaya.py                kRO price fetcher
├── scrape_carded.py                 carded builds from iRO listings (ragnastats)
├── carded.json                      their cache: base item, refine, cards, listings
├── card_adjectives.json             iRO's card prefixes, to read those names
├── prices_kro.json                  kRO price cache (RagMAYA)
├── prices.json                      iRO price cache (ragnastats)
└── table_generated*.json            what it last wrote, to spot hand edits
```
