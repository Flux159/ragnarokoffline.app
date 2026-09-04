# login-screen

Replaces the login background with your own picture. One layer, `data/`, and
the shallowest possible proof that a mod's files are served ahead of the GRFs.

<img src="../../../docs/assets/modlogin.jpg" alt="The login screen showing this mod's artwork" width="640">

## What to look at first

The filenames. There are twelve of them, and none of them is `login_bg.bmp`.

For every packet version from 2018-11-14 to 2022-12-07 — which includes the
20221005 this app ships — the client builds its login background out of a
**4 × 3 grid of twelve images**, each stretched to a quarter of the window's
width and a third of its height. You can see the list in
`vendor/roBrowserLegacy/src/UI/Background.js`, `getLoginBackgroundName`.
Replacing one of them changes one twelfth of the screen.

They live at:

```
data/texture/À¯ÀúÀÎÅÍÆäÀÌ½º/t_¹è°æ1-1.bmp   ...1-4    top row, left to right
data/texture/À¯ÀúÀÎÅÍÆäÀÌ½º/t_¹è°æ2-1.bmp   ...2-4    middle row
data/texture/À¯ÀúÀÎÅÍÆäÀÌ½º/t_¹è°æ3-1.bmp   ...3-4    bottom row
```

`À¯ÀúÀÎÅÍÆäÀÌ½º` is `유저인터페이스` and `t_¹è°æ` is `t_배경`, stored as CP949
bytes that every tool in the chain reads as Latin-1. **Copy those names, do not
retype them**, and do not "correct" them to Korean — a directory named in
Korean is one the client never looks in.

The extension is `.bmp` and the contents are JPEG. Browsers decode by content,
not by name, and this is the difference between a 200 KB mod and a 2.4 MB one.

`t_login.jpg` and `bgi_temp.bmp` are here too. The client asks for those
instead on packet versions above 2022-12-07 and below 2018-11-14, so shipping
all three means the mod keeps working if the app's packet version moves.

## Making your own

```
scripts/mkloginbg.py my-art.png --out examples/mods/login-screen/data
```

Feed it any 4:3 image. The login form sits low and centre, so leave the
middle-bottom uncluttered and put your wordmark high.

## Applying it

Client assets are linked when the app starts, not when the server restarts, so
this needs the **app** restarted — and the asset server caches every file it
has served, so a changed image that appears not to take is usually a cached
one.
