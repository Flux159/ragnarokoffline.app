# Tutorial: adding a `@give` command

By the end of this tutorial you'll be able to type this in chat:

```
@give Red Potion 10
```

and have ten Red Potions go into your inventory. You'll also be able to give
items to a friend who is playing on your server.

You don't need to compile anything. The whole command is one script file in a
mod. If you haven't made a mod before, read [Getting started](gettingstarted.md) first.
This tutorial assumes you know where the mods folder is and how to Apply.

> **Doesn't `@item` already do this?** Yes. The default `ragnarok` account is a
> GM, and `@item 501 10` works out of the box. This tutorial isn't really about
> items. It shows you how to **make your own chat command**, which you can use
> for anything: teleports, buffs, minigames. `@give` is a friendlier `@item`,
> because it accepts item names with spaces and suggests matches when you
> misspell one.

---

## Why `@give` and not `/give`?

The two prefixes are handled in different places:

- **`/` commands never leave your computer.** The game client handles `/sit`,
  `/effect`, `/bgm` and the rest itself. For a `/` command it doesn't know, it
  prints *command not found* and sends nothing to the server.
- **`@` commands go to the server**, which is where your mod's script runs.

So a command added by a mod starts with `@`.

---

## Step 1: The smallest command that works

Make this mod:

```
give-command/
├── mod.json
└── npc/
    └── give.txt
```

**`mod.json`**

```json
{
  "name": "give-command",
  "version": "1.0.0",
  "author": "you",
  "description": "Adds @give <item> [amount]."
}
```

**`npc/give.txt`**

```
-	script	give_command	-1,{
OnInit:
	bindatcmd "give", strnpcinfo(3) + "::OnGive", 99, 99;
	end;

OnGive:
	getitem 501, 1;
	dispbottom "Here is a Red Potion.";
	end;
}
```

> ⚠️ The first line uses **TABs** between `-`, `script`, `give_command` and
> `-1,{`. If you use spaces, the script won't load.

Apply, log in, and type `@give`. A Red Potion appears in your inventory.

What each part does:

| Line | Meaning |
|---|---|
| `-	script	give_command	-1,{` | A script with **no body in the world**. The `-` means it isn't on any map, and `-1` means it has no sprite. It exists only to hold code. |
| `OnInit:` | Runs once, when the server starts. |
| `bindatcmd "give", …` | "When someone types `@give`, run the `OnGive` label in this script." |
| `strnpcinfo(3)` | This script's own name (`give_command`). Using it means you can rename the script without breaking the command. |
| `99, 99` | Who may use it (group levels): the first number for `@give`, the second for `#give`. More on both below. |
| `OnGive:` | The code that runs when the command is typed. |
| `dispbottom` | Prints a line in the typing player's chat box. Only they see it. |

---

## Step 2: Read what the player typed

When the command runs, rAthena gives your script three variables:

| Variable | For `@give Red Potion 10` |
|---|---|
| `.@atcmd_numparameters` | `3` |
| `.@atcmd_parameters$[0]` | `"Red"` |
| `.@atcmd_parameters$[1]` | `"Potion"` |
| `.@atcmd_parameters$[2]` | `"10"` |

rAthena splits the text on spaces, so a two-word item name arrives as two
parameters. We'll deal with that like this:

- If the **last word is a number**, it's the amount.
- **Everything before it** is the item name, and we join the words back
  together with spaces.

Some names you'll see in scripts:

- `.@` means the variable is thrown away when this command finishes.
- `$` on the end means the variable holds text. Without it, the variable holds
  a number.

---

## Step 3: The full command

Replace `npc/give.txt` with this:

```
// @give <item name or ID> [amount]
//
//   @give Red Potion 10
//   @give 501 10
//   @give Red_Potion
//
-	script	give_command	-1,{
OnInit:
	bindatcmd "give", strnpcinfo(3) + "::OnGive", 99, 99;
	end;

OnGive:
	// No parameters: explain how to use it.
	if (.@atcmd_numparameters == 0) {
		dispbottom "Usage: @give <item name or ID> [amount]";
		dispbottom "  e.g. @give Red Potion 10";
		end;
	}

	// If the last word is a number (and not the only word), it's the amount.
	.@amount = 1;
	.@words = .@atcmd_numparameters;
	.@last$ = .@atcmd_parameters$[.@words - 1];
	if (.@words > 1 && .@last$ == "" + atoi(.@last$)) {
		.@amount = atoi(.@last$);
		.@words = .@words - 1;
	}

	// Join the remaining words back into the item name.
	.@item$ = .@atcmd_parameters$[0];
	for (.@i = 1; .@i < .@words; .@i++)
		.@item$ = .@item$ + " " + .@atcmd_parameters$[.@i];

	// An ID ("501") or a name ("Red Potion" / "Red_Potion")?
	if (.@item$ == "" + atoi(.@item$)) {
		.@id = atoi(.@item$);
		if (getitemname(.@id) == "null") {
			dispbottom "There is no item with ID " + .@id + ".";
			end;
		}
	} else {
		.@id = getiteminfo(.@item$, ITEMINFO_ID);
		if (.@id == -1) {
			// Not an exact name. Offer close matches instead of guessing.
			.@count = searchitem(.@found[0], .@item$);
			if (.@count == 0) {
				dispbottom "No item called \"" + .@item$ + "\".";
				end;
			}
			dispbottom "No exact match for \"" + .@item$ + "\". Did you mean:";
			for (.@i = 0; .@i < .@count; .@i++)
				dispbottom "  @give " + .@found[.@i] + "   (" + getitemname(.@found[.@i]) + ")";
			end;
		}
	}

	// Keep the amount sensible.
	if (.@amount < 1) .@amount = 1;
	if (.@amount > 30000) .@amount = 30000;

	// Check first. getitem on a full bag fails halfway through.
	if (!checkweight(.@id, .@amount)) {
		dispbottom "Can't carry " + .@amount + " x " + getitemname(.@id) + ". Too heavy, or no free slots.";
		end;
	}

	getitem .@id, .@amount;
	dispbottom "Received " + .@amount + " x " + getitemname(.@id) + ".";
	end;
}
```

Click **Apply** again. The server has to restart to load the new script.

### Try it

| Type | Result |
|---|---|
| `@give` | the usage message |
| `@give Red Potion 10` | 10 Red Potions |
| `@give 501 10` | same, by ID |
| `@give Apple` | 1 Apple |
| `@give Potion` | no exact match, so it lists up to ten items with "Potion" in the name and their IDs |
| `@give Knife 5` | 5 Knives. Equipment doesn't stack, so each one takes an inventory slot |

The lookups used in the script:

- **`getiteminfo(name, ITEMINFO_ID)`** finds an item by its **exact** name,
  either the display name (`Red Potion`) or the internal name (`Red_Potion`).
  Upper or lower case doesn't matter. It returns `-1` when nothing matches.
- **`searchitem`** finds every item **containing** the text, up to ten. It's
  only used to suggest names, because "Potion" matches dozens of items and
  guessing which one the player meant would give them the wrong item.
- **`checkweight`** answers "can this player carry that?" If `getitem` runs
  out of space partway, the player gets part of the stack and the script stops
  with an error, so it's worth checking first.

---

## Step 4: Give to a friend

**You don't need to write anything for this.** rAthena gives every `@command`
a `#` twin that runs **on another player**:

```
#give "Friend Name" Red Potion 10
```

Put the character name in quotes if it contains spaces. The friend has to be
online.

This works because with `#`, your script runs **as the friend**. The
`getitem`, `checkweight` and `dispbottom` in the script all apply to the
friend, so they get the item and the "Received…" message. The only catch is
that if you mistype the item name, the error message also goes to the friend's
chat box and not yours.

---

## Step 5: Decide who can use it

The two numbers in `bindatcmd` are **group levels**: the lowest level allowed
to use `@give` and `#give`.

```
bindatcmd "give", strnpcinfo(3) + "::OnGive", 99, 99;
//                                            │   └─ #give (on others)
//                                            └───── @give (on yourself)
```

| Level | Who that is |
|---|---|
| `99` | Admins. The default `ragnarok` account is one. |
| `0` | **Everyone**, including every account a friend creates on your server |

If an account's level is too low, `@give` isn't recognised and the text is
sent as an ordinary chat message instead.

So:

- **Only you:** leave both at `99`.
- **Everyone can give themselves items, but only you can give to others:**
  `0, 99`. If you play alone or with friends and want a "creative mode", this
  is probably the setting you want.
- **Everyone can do both:** `0, 0`. Only do this on a server where you trust
  everybody.

To make a friend's account an admin instead, stop the game and run:

```sh
ragnarok-stack sql --write "UPDATE login SET group_id = 99 WHERE userid = 'their_login'"
```

---

## Ideas for your next command

You now have the full pattern: `bindatcmd`, read `.@atcmd_parameters$`, then do
something. The same pattern works for other commands:

- **`@home`**: `warp "prontera", 156, 191;`
- **`@heal`**: `percentheal 100, 100;`
- **`@buffme`**: `sc_start SC_BLESSING, 600000, 10;` and friends
- **`@kit`**: a starter pack of items handed out once, remembered with a
  character variable such as `givecmd_kit_claimed` (no `.@` prefix, so it's
  saved)

rAthena's
[script_commands.txt](https://github.com/rathena/rathena/blob/master/doc/script_commands.txt)
lists every command. Search it for `bindatcmd` to see the related `unbindatcmd`
and `useatcmd`.

## Troubleshooting

- **Typing `@give` just says "@give" in chat.** Either the script didn't load
  (check the TABs, then the server log), or your account's level is below the
  number in `bindatcmd`.
- **The server log.** Script errors are printed with the file name and line
  number:

  ```sh
  ~/Library/Application\ Support/Ragnarok\ Offline/runtime/bin/ragnarok-stack logs map 100
  ```

- **You edited the script and nothing changed.** Click **Apply** again. The
  server only reads scripts when it starts.
