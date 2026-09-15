# BZW map features

Staging plan for the BZW keywords `docs/bzw.md` lists under "What is ignored" --
the map-format features upstream has that bzo does not read yet. Upstream
references are paths under `$HOME/bzflag/`; the format itself is also
documented at
<https://projects.porteighty.org/bzw_docs/documentation/world-design/bzw/>.

Issue #72 tracks this as a whole; open a narrower issue instead if one section
here turns into its own multi-week effort, the way flags split out to #6 and
commands to #5.

## Working method

**Validate against a real map before writing bzo's own.** Every keyword here
has years of maps already written against it; a hand-written three-line test
fixture proves the parser accepts bzo's own assumptions, not that it agrees
with what mappers actually wrote. Before starting a section, find or fetch a
real `.bzw` that exercises it, run it through `parseBZWMap`, and fix
disagreements before calling the section done.

No third-party map pack with mesh/group/physics-driver usage in the wild turned
up on a search of the BZFlag-Dev GitHub org or the usual community sites --
BZFlag ships no sample maps using them either. The porteighty `bzw_docs` pages
for `mesh`, `group`, and `waterLevel` each carry a complete, runnable example
block, though, which is the next best thing to a real map and is cited per
section below. `arc`/`cone`/`sphere`/`tetra`'s docs pages are unfinished --
placeholder text where an example should be -- so those four are validated
against `$HOME/bzflag/src/bzfs/Custom{Arc,Cone,Sphere,Tetra}.cxx` directly
rather than against any map, real or documented, until one turns up.

**Once a keyword works, give it a home and delete the section here.** A
per-obstacle keyword (mesh, group, material, phydrv) gets a labelled corner of
`bzo.bzw`, the same treatment every obstacle and passability keyword already
has there. A **map-wide** one -- anything on the `world` block itself, since a
map has exactly one -- cannot share `bzo.bzw` that way: `noWalls` on the map
that also demos every other obstacle would delete the border every other
example relies on, and a single `waterLevel` cannot show two heights at once.
A `-set` weather preset is the same kind of map-wide singleton, one map either
raining or not. Those get their own small map instead, in the style
`collision-test.bzw`, `pizza_box.bzw` and `empty.bzw` already set: one
purpose, named for it. Either
way, `docs/bzw.md` moves the keyword out of "What is ignored" and into
whichever section documents it, with the same rigor -- upstream source, the
conversion bzo applies, what a mapper needs to know. This plan file shrinks as
sections close, down to nothing; git history holds the record of what closed,
so nothing here should say "done" and stay.

**Map Viewer previews most of this without a live match.** Picking a map in
the join dialog's Map Viewer loads and renders its geometry immediately, and
its driveable phantom tank (`AGENTS.md`, "Map Viewer" -- `ROAM_VIEW.DRIVE_FP`/
`DRIVE_TP`) runs the same client-side collision and motion a real tank's
client owns, unvalidated by the server since nothing about a preview is a real
player. That is enough to check mesh/group collision, a `noWalls` map's open
edge, or a physics driver's push, by driving into it and watching what
happens -- no second client, no team to join, no server restart. What it
cannot check is anything the *server* decides: a driven tank's position is
never anti-cheat-validated in a preview, so a physics driver's interaction
with `antiCheat.collisionSlack` and the server's extrapolation still needs a
real client on the live map, not a Map Viewer session.

## Mesh geometry

`mesh`/`meshbox`/`meshpyr`/`arc`/`cone`/`sphere`/`tetra` are parsed, textured,
placed through `group` (including from inside a nested `define`), rendered,
collided with (tank and shot, oriented tank box and concave shapes included,
per-face `drivethrough`/`shootthrough`), radar-drawn, and debug-labelled. See
"Mesh and its primitives" in `docs/bzw.md` for the full detail of what a
mapper can rely on; `src/bzfs/CustomMesh.cxx`, `src/bzfs/CustomMeshFace.cxx`,
and each primitive's own `Custom*.cxx` remain the upstream reference. What is
left:

- [ ] Merge a mesh's own adjacent same-material triangle ranges into one
      `geometry` group rather than one per face -- `_buildMeshObject` adds a
      group per face regardless, one draw call per face rather than one per
      distinct texture. Fine at `bzo.bzw`'s scale; worth doing before a
      130-mesh map like `import-Planet-MoFo.com_4202.bzw` renders at its own
      real scale.
- [ ] Name a mesh's own individual faces in the collision log, the way a
      box's face selectors are named today -- a mesh's debug label already
      names the whole mesh, but not which face a report is against.
- [ ] `checkPoints` -- upstream's own aid for telling a mesh's inside from its
      outside on an arbitrary shape -- is not read: bzo's own collision never
      needs to ask that question, so there is nothing to port it onto yet.

## Groups and transforms

`define` / `enddef` / `group` are read now, including a `group` instance
nested inside a `define` -- real recursion, matching `GroupDefinition::
makeGroups`, not the flat single level first shipped. See "Groups" in
`docs/bzw.md` for what a `group` instance takes, how nesting composes, and how
a member's name is kept unique at any depth -- including a `teleporter`
placed through one, which is also read now, the same as any other member.
`src/bzfs/CustomGroup.cxx` remains the reference for what is left.

`shift`/`scale`/`spin` are read now too, as `WorldFileLocation`'s own names
for the position/size/rotation triple `CustomGroup` already folds into the
same transform -- `shift` and a vertical-axis `spin` on any obstacle, `scale`
only inside a `group` (a plain box's own `size` already means its literal
half-extent, not a multiplier, and no local map names one through `scale`
instead). See "Groups" in `docs/bzw.md` for the detail and the real map lines
that motivated it (`ahs3_Ironside_Battlefield.bzw`'s `table`/`fence` groups).
What is left:

- [ ] A bare `transform` / `enddef` block's `shift`/`scale`/`shear`/`spin`
      lines composed into one named matrix, and `xform <name>` referencing it
      from inside a `group` block or a plain obstacle.
- [ ] `shear`, on a plain obstacle or inside a `group` block -- no
      representation in bzo's axis-aligned box/pyramid model at all.
- [ ] `scale` stated directly on a plain box or pyramid, no `group` involved.
- [ ] A `spin` about anything but the vertical axis -- tips a shape out of
      bzo's axis-aligned model the same way `shear` does. Only real local use
      is `ahs3_INCOMING.bzw`'s "3way" groups, and it is moot there today: that
      define is pure `mesh`, so there is nothing yet to tip. Revisit once mesh
      geometry lands, alongside a general oriented box/pyramid representation
      or upstream's own mesh-conversion fallback -- whichever this needs by
      then.

## Materials and appearance

`material` / `matref`, `texture`, `texsize`, `texoffset`, `dynamicColor`,
`textureMatrix`, and the lighting inputs `ambient`, `specular`, `emission`,
`shininess`, plus the flags `noradar` and `nolighting`.
`src/bzfs/CustomMaterial.cxx`, `src/common/ParseMaterial.cxx`.

**`material`/`matref`/`addtexture`/`texture` are read now**, resolving a
named stock texture against bzo's existing asset set exactly as "Evidence
from real maps" below predicted, plus `color`/`diffuse` as a tint (already
read on a plain obstacle; a `matref` is just a second way to state it),
`noradar` and `nolighting`. **An external texture URL is read too, and
forwarded to the client** -- the server itself never fetches one; each
connected browser decides for itself whether to, against an allowlist (its
own origin, or `*images.bzflag.org`) and the browser's own CORS enforcement
on top of that. See "Materials" in `docs/bzw.md` for the full syntax, the
stock-texture list, and what a material still cannot say. What is left:

### Evidence from real maps

Pulled four real maps rather than guess at what a `material` block actually
says in the wild -- `bz-next/bz-next.github.io`'s `maparchive/`, which matches
names still on the public server list today (`bzflag.allejo.io`'s "Ironside
Battlefield FFA", and a "Missile War" lineage several DarkWorld-descended
servers still run). Every texture-naming line in them is `addtexture` (the
real keyword upstream writes; a bare `texture` line never appeared once), and
it names one of two things:

- Upstream's own stock texture, by name with no path -- `boxwall`, `wall`,
  `roof`, `pyrwall`, `telelink`, `caution`, and one called `mesh` (a stock
  wireframe/grid texture, unrelated to mesh *geometry* -- see the callout in
  `docs/bzw.md`'s "Materials" section, so the two "mesh"es are never confused
  with each other). bzo already shipped an equivalent PNG for six of these
  under `public/textures/`, which is what `resolveBzwStockTexture` resolves
  against.
- One external URL, out of everything sampled:
  `http://images.bzflag.org/astevens/pine.png`, in a "wood" material. The
  BZFlag forums document uploading a texture there and linking it into a
  `material` block, so the host is real and mappers do use it -- just rarely,
  next to naming a stock texture. `maps/bzo.bzw`'s `thin_wall` names this
  same URL now, permanently, and it actually shows the real picture:
  `images.bzflag.org` sends `Access-Control-Allow-Origin: *` on every response
  (checked directly), so the browser's CORS check passes and the load
  succeeds.

This is what made resolving a named texture against bzo's *existing* asset
set almost the whole of what a real map's `material` block asks for, with an
absolute URL -- the one thing left outside that asset set -- read too, but
never fetched by bzo's own server: see "Materials" in `docs/bzw.md` for the
client-side trust decision (`isExternalTextureUrlTrusted` in
`public/texture.js`) and its own CORS check, which `images.bzflag.org`
passes. Geometry-wise, two of the four
sampled maps were pure box/pyramid plus `group`, zero mesh; the other two
leaned on `arc` (a mesh generator) for curved walls, so mesh remains
necessary eventually rather than skippable forever -- see "Mesh geometry"
above, and every `matref` actually sampled turned out to be inside one of
those unread `mesh` faces or `arc` primitives rather than on a plain
`box`/`pyramid` -- material support pays off on today's real maps only once
mesh geometry does too.

- [ ] `texsize`/`texoffset` scaling and shifting a `matref`'d or
      `addtexture`'d picture's UVs upstream's own way, rather than every
      obstacle of a kind sharing that kind's own baked-in tiling regardless
      of what material it wears.
- [ ] `dynamicColor` and `textureMatrix` -- animated tint and scrolling/
      rotating UVs. Both are upstream's `useQuality`-gated best-looking
      variants of a texture that is otherwise static, which is the case
      "Fewer options than BZFlag" in `AGENTS.md` already covers: implement the
      variant, ship no setting.
- [ ] `ambient`/`specular`/`emission`/`shininess` need a lighting model that
      reads them -- bzo's renderer lights obstacles one way today, so this is
      the one item here that is a rendering-architecture question first and a
      parser task second.
- [ ] `matref`/`addtexture`/`tint` on a `group` instance, and on a `mesh`
      face once mesh geometry itself is read -- the material registry does
      not care which obstacle asks it for a texture, so a face's own `matref`
      is a consumer of this section to add, not a second implementation of
      it. See "Groups and transforms" and "Mesh geometry" above.

## Physics drivers

`phydrv`, defined by a `physics` / `enddef` block and referenced from an
obstacle or a mesh face. `src/bzfs/CustomPhysicsDriver.cxx`,
`include/PhysicsDriver.h`.

A physics driver is a velocity added to a tank standing on (or passing
through) a surface that names it -- a conveyor belt, in the common case, and
also upstream's mechanism for a "death" surface (`-set` style, killing
outright) or a slide (removing friction) rather than pushing. This is a
gameplay change, not only an importer one: it lives beside the pyramid
support-surface rules in `AGENTS.md`'s motion section, because "what surface
is a tank standing on and what does that surface do to it" is exactly the
question `resolveTankMotion` already answers for a slope.

The porteighty docs page has standalone examples of a `linear` conveyor, a
`bounce`, an `ice`-style `slide`, and a `death` mine, but none show the
`phydrv <name>` line that attaches one to an obstacle -- confirm that syntax
against `CustomBox.cxx`/`CustomMeshFace.cxx` directly, and treat the driver
definitions as the validated half.

- [ ] Parse `physics` / `enddef` (linear velocity, angular velocity about a
      point, `slide`, `death`) into a named driver table, and `phydrv` on an
      obstacle, mesh face, or group into a reference onto it.
- [ ] Extend `resolveTankMotion` (the shared `motion` pair) to add a driver's
      velocity while a tank's support surface carries one -- both ends need
      the same answer, the way every other motion rule here does, so this
      needs the parity test the pair's existing rules have.
- [ ] Decide how a conveyor interacts with bzo's `antiCheat.collisionSlack`:
      a driven tank's position is no longer purely a function of the stick,
      so the server's extrapolation (`getPredictedState`) needs to know about
      the same driver the client integrated.
- [ ] Visuals: upstream draws nothing for a conveyor's belt motion itself, but
      a mapper marks one with an animated texture (`dynamicColor`/
      `textureMatrix` above) -- worth sequencing physics drivers after
      materials for that reason, or accepting a plain conveyor with no visual
      cue until materials land.

## Water

`waterLevel`, a single plane at a height. `src/bzfs/CustomWaterLevel.cxx`.

The smallest item here: one `height` plus a `matref` for its surface, no
collision effect upstream (a tank drives through it same as air) and no
gameplay change. Reads as a straightforward render-only addition once
`matref`/material support exists to texture it, or with a plain flat-shaded
plane before that lands. A world-block keyword like `noWalls` -- one map, one
height -- so it needs its own small map to preview in Map Viewer rather than a
corner of `bzo.bzw`.

- [ ] Parse `waterLevel` / `endwaterlevel`'s `height`.
- [ ] Draw a single translucent plane at that height in `render.js`.

## Weather

Rain, and the five other particle presets `_rainType` names -- `snow`,
`fatrain`, `frog`, `particle`, `bubble`, plain `rain` -- plus the `_rain*`
BZDB family that tunes one (`_rainDensity`, `_rainSpeed`, `_rainSpeedMod`,
`_rainSpread`, `_rainSize`, `_rainStartZ`/`_rainEndZ`, `_rainBaseColor`/
`_rainTopColor`, `_rainTexture`, `_useRainPuddles`/`_rainPuddleColor`/
`_rainPuddleTexture`/`_rainMaxPuddleTime`/`_rainPuddleSpeed`, `_useLineRain`,
`_useRainBillboards`, `_rainSpins`, `_rainRoofs`). `src/bzflag/WeatherRenderer.cxx`
picks a preset's defaults for every one of those a map or config does not
override; `_rainRoofs` beyond 1 also decals puddles onto roof surfaces the
rest of the rain is culled above (`src/bzflag/RoofTops.cxx`).

There is no BZW keyword of its own -- like `_maxFlagGrabs`, this is the
generic `-set` mechanism `docs/bzw.md` already threads into `GAME_CONFIG`, a
map's `options` block setting a locked BZDB variable no player-facing setting
ever touches. It gets a section here rather than living under "Leftovers"
because it is a dozen variables that only make sense set together, not one
value with one meaning, and because "**Implement the highest quality option
upstream has for a given effect, and ship no setting for it**" (`AGENTS.md`,
"bzo does not mirror BZFlag's client display options") applies directly: pick
the best-looking preset's rendering path -- billboarded drops, textured,
puddled, roof-culled -- and do not carry `doLineRain`'s plain streaks or
`userRainScale` as a client setting.

Purely a client render, same as water: no collision, nothing a shot or a tank
interacts with, so a preview map is sufficient on its own -- no live match,
no second client, and Map Viewer's driveable phantom tank is not even needed,
just look at the sky.

- [ ] Parse the `_rain*` family through the map's `options` block into
      `GAME_CONFIG`, `-set`'s existing path.
- [ ] Pick one rendering path (billboarded particles, textured, puddled,
      roof-culled at `_rainRoofs` 2) and build every preset atop it rather
      than porting `doLineRain`/`doBillBoards` as a second code path.
- [ ] A small map naming one preset, to preview in Map Viewer.

## Leftovers

Small enough to fold into whichever section lands near them, or to take as a
single pass once the rest of this plan is empty:

- [ ] Any `-set` variable beyond the three bzo already threads through
      (`_maxFlagGrabs`, `_wingsJumpCount`, `_maxBumpHeight`) stays a
      map-by-map judgment call -- add a config knob for one only when a map
      that needs it shows up, per `docs/flags.md`'s existing rule for these.

Not planned: `-helpmsg`. Its argument is a path on the server's filesystem, and
upstream itself refuses to take one from a world file
(`checkFromWorldFile`, `CmdLineOptions.cxx:337-344`) for exactly the reason bzo
would inherit worse -- every option here arrives through a map's `options`
block, and a map is not only something an operator hand-wrote; see
`docs/bzw.md`'s note on `-helpmsg` under "The options block".
