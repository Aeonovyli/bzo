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

`mesh` / `meshbox` / `meshpyr`, and the primitives `arc`, `cone`, `sphere`,
`tetra` that expand to one. `src/bzfs/CustomMesh.cxx`,
`src/bzfs/CustomMeshFace.cxx`, `src/obstacle/MeshObstacle.cxx`.

A `mesh` block is a vertex/normal/texcoord pool (`vertex`, `normal`,
`texcoord`) and a run of `face` ... `endface` blocks, each naming indices into
those pools plus its own `matref`, `phydrv`, and the same four passability
keywords box and pyramid already take -- but **per face**, not per obstacle:
one face of a mesh can be `drivethrough` while its neighbour is solid.
`smoothbounce` softens a ricochet's angle at a vertex seam, `noclusters` and
`decorative` are renderer hints, `drawInfo` swaps in a separate low-poly LOD
mesh for display while the face list above stays what collides.

This is the largest single gap: it is what a mapper reaches for once boxes and
pyramids run out, and it needs work on every surface bzo has.

**The vertex/normal/texcoord pools and the face list are parsed now.**
`parseBZWMap` reads a `mesh` block's own grammar in full -- the pools, a
mesh's own defaults (`phydrv`, `noclusters`, `smoothbounce`, `decorative`,
passability, `matref`/`addtexture`/`color`/etc, the same read
`applyBzwMaterialToken` gives a `material` block), and each `face`/`endface`
snapshotting those defaults at the moment it opens and overriding any of them
itself -- validated against all three complete example blocks on
<https://wiki.bzflag.org/Mesh> (a textured cube, a billboard built from
explicit `texcoord`s, and a jump-through floor), and against
`ahs3_INCOMING.bzw`'s own "3way" mesh, whose parsed vertex/normal/face counts
match its own header comment (`# faces = 52`, `# vertices = 40`,
`# normals = 40`) exactly.

**Rendered now, and placed in `obstacles`.** A parsed mesh is a real entry in
`OBSTACLES`/`obstacles` (`type: 'mesh'`) now, the same list every box/pyramid/
teleporter/base is in -- so the radar, the buried-face test and the eighth-
dimension nodes only ever have to skip a shape they don't handle, rather than
learn a second array exists. `render.js`'s `setMeshes`/`_buildMeshObject`
builds one `THREE.Mesh` per parsed mesh: every face fan-triangulated into a
shared buffer, grouped by its own resolved texture/tint
(`resolveObstacleTextureFactory`, the same read a box's own wall/cap textures
use), flat-shaded off its own plane unless it gave `normal`s of its own. A
face with no `texcoords` line of its own is planar-projected rather than left
at vertex 0's own degenerate (0,0) for every corner -- upstream's own
`MeshSceneNodeGenerator::makeTexcoords`, ported faithfully (the first edge as
U, the face's own plane crossed with it as V, both at the same 8-unit tile
size a box's own wall already uses) -- without it, a stock texture like
`boxwall`/`pyrwall` samples one corner pixel across the whole face instead of
tiling, which reads as a flat wash of colour rather than a texture at all.
`maps/bzo.bzw` carries one of each of the three wiki.bzflag.org shapes now
(`mesh_cube`, `mesh_billboard`, `mesh_jump_through_floor`, clear of the corner
tests) as a real render-path fixture, not only a parser one -- confirmed
rendering with the right vertex/group/material counts in a headless client,
`renderer.stats`' own `mesh:N` draw tally among them.

**The collision pair skips `type === 'mesh'` explicitly, and has to.**
`findTankObstacle`/`findShotObstacle`/`findShotSegmentImpact` (both
`server/collision.cjs` and `public/collision.mjs`) `continue` past one before
any of the box/pyramid math runs, which is not just tidiness: a mesh's
missing `w`/`d`/`h`/`x`/`z`/`rotation` do not fail safe. The vertical overlap
test alone stays well-defined (`getObstacleHeight`'s `DEFAULT_OBSTACLE_HEIGHT`
fallback, `baseY || 0`), so it can pass; `testOrigRectRect`'s corner
classification then divides by the missing half-extents, and `NaN < x` and
`NaN > x` are both false for every corner, which is the *inside* case in
that function's own logic (`rx`/`rz` fall through to 0), so an unguarded mesh
does not fail to collide -- it collides with everything, unconditionally.
Merging mesh into `obstacles` without this guard shipped briefly and made
every tank movement check return a hit; a debug log formatting the (also
missing) `obs.x`/`obs.rotation` with `.toFixed()` turned that into a thrown
exception on every collision message besides. Both are fixed by the same
guard, landed together with the merge; `render.js`'s own box/pyramid/
teleporter/base dispatch has no `type === 'mesh'` case either, so
`applyWorldData` in `client.js` filters a mesh out of what it hands
`setObstacles` (into `setMeshes` instead) rather than teaching that dispatch
a fifth shape it would otherwise build from the same missing fields.

**A `define`'s own meshes are placed through `group` now too**, the same way
its box/pyramid members already were -- `resolveDefineMeshes`/
`applyGroupInstanceTransformToMesh` are `resolveDefine`/
`applyGroupInstanceTransform`'s own mesh equivalents (same scale/spin/shift,
applied per vertex/checkpoint/normal instead of to one position), recursed
through nested `group` instances the same way. This is most of what a real
map's mesh content actually needs: every mesh sampled across
`ahs3_INCOMING.bzw`, `ahs3_Paradise_Valley.bzw`, `ahs3_XUG_FFA.bzw`,
`dw_missilewar3.bzw` and `import-Planet-MoFo.com_4202.bzw` sits inside a
`define`, never at the map's own top level -- confirmed against that last
one's own `base_pillar`/`base_oval` chain, four `group` levels deep
(`all#0:base_pillars#0:base_pillar#0:base_oval#0`), landing 277 distinct
placed meshes from 130 template ones, each at its own correctly transformed
position.

A mesh no longer counts toward the player-facing "dropped" tally at all --
`parseBZWMap` merges it into `obstacles` before that tally runs now, the same
point box/pyramid/base/teleporter join at, since a mesh renders, collides and
shows on radar the same as they do. What is left:

- [ ] Merge a mesh's own adjacent same-material triangle ranges into one
      `geometry` group rather than one per face -- `_buildMeshObject` adds a
      group per face regardless, which is one draw call per face
      (`renderer.stats`' `mesh:14` for three small test shapes) rather than
      one per distinct texture. Fine at `bzo.bzw`'s scale; worth doing before
      a 130-mesh map like `import-Planet-MoFo.com_4202.bzw` ever renders for
      real.
**A tank now collides with a mesh, per face -- concave shapes included.**
Checking upstream first paid off: `MeshFace` is its own `Obstacle` subclass,
tested as an independent flat polygon rather than upstream ever asking "is
this point inside the enclosed volume" -- which is exactly why a concave
mesh (an arch, a tunnel) needs nothing special, upstream or here. `obs.bounds`
(a mesh's own AABB, `finalizeMeshGeometry`) rejects the whole mesh in one
check before any face runs; each surviving face is tested with a JS port of
upstream's own `testPolygonInAxisBox`/`projectAxisBox`/`projectPolygon`
(`Intersect.cxx`) against `meshIntersectsCylinder` (`findTankObstacle`'s
cylinder path in both `collision.cjs` and `collision.mjs`) -- a face's own
world-space plane, precomputed the same best-of-every-triple-vertices way
`MeshFace::finalize` picks one (`computeMeshFacePlane`, robust against a
near-degenerate polygon). Verified against hand-built cases and against
`bzo.bzw`'s own three real parsed mesh fixtures directly (not just synthetic
data) before this reached the live server.

**The oriented tank box is a separate, precise case now.** `MeshFace::inBox`
(MeshFace.cxx:454) is `inCylinder`'s own real ancestor -- `inCylinder(p,
radius, height)` is just `inBox(p, 0, radius, radius, height)`, the square
footprint collapsed to zero rotation -- so the general case only needed the
angle upstream already carries: `findMeshHitFaceOriented` translates each
face to the tank's position and rotates it by the tank's own heading
(upstream's own reasoning for rotating the polygon rather than the box:
cheaper, tris and quads being the common case), then runs the same
`testPolygonInAxisBox` against a plain axis-aligned box sized to the tank's
actual `halfWidth`/`halfLength` rather than a `radius` circle. `findTankObstacle`'s
mesh branch now matches its box and pyramid neighbours exactly: `useTankBox`
picks `meshIntersectsTank`, otherwise the existing `meshIntersectsCylinder`.
Verified against hand-built cases where the two disagree by construction: a
tank facing a narrow wall nose-on reaches it with its `halfLength` (3 units)
and hits, the same tank turned broadside reaches only its `halfWidth` (1.4
units) and misses -- exactly where the old circular approximation still
reported a hit either way.
**Shots collide with a mesh now too -- with a real ray-vs-face test, not the
tank's own box-overlap approximation.** The first version reused
`meshIntersectsCylinder` for shots exactly as the tank path does, and it
shipped, worked in easy testing, and was wrong: a mesh face has none of a
box or a pyramid's real volume to be "inside" of, so the endpoint-only
`findShotImpact` (an ordinary shot's own per-tick path) only ever catches a
face if a single ~1.6-unit tick happens to land within `SHOT_COLLISION_RADIUS`
(a tenth of a unit) of the exact plane -- checked upstream and found the
reason it never has this problem: `ShotStrategy::getFirstBuilding`
(ShotStrategy.cxx:84) calls `obs->intersect(ray)`, a real ray/geometry
intersection, immune to step size, not a discretized sample. `findMeshFaceCrossing`
now does the same: an exact ray-vs-plane crossing (offset by the shot's own
radius, so its surface reaches the face before its centre point does), then
`pointInMeshFacePolygon` checks the crossing point against the face's actual
boundary rather than its infinite plane (upstream's own dominant-axis-drop
trick). `findMeshRayImpact` folds this into both `findShotImpact` (the
ordinary per-tick path) and `findShotSegmentImpact` (the Laser's whole-
lifetime-in-one-segment path, which drops a mesh from its own coarse-sample
candidate loop entirely now and answers for it here instead). Reproduced the
original bug first, then confirmed the fix, with a real per-tick simulation
at `SHOT_SPEED`'s default (100u/s) against `bzo.bzw`'s own parsed
`mesh_octagon`: a shot fired straight up through its floor, straight down
through its roof, and straight in through a wall all now stop exactly at
each plane; all three passed clean through before this landed.

**Per-face `drivethrough`/`shootthrough` are read into every face
(`parseBZWMap` always did), but nothing checked them until now.**
`findMeshHitFace`, `findMeshHitFaceOriented`, `meshIntersectsCylinder` and
`meshIntersectsTank` all take a `passField` naming which of a face's own two
flags this particular query cares about -- `driveThrough` for a tank,
`shootThrough` for a shot and for `findMeshFaceCrossing`'s own per-face
skip -- so a face a tank passes through still stops a shot and the reverse,
matching docs/bzw.md's own claim that "one face of a mesh can be
`drivethrough` while its neighbour is solid." Found by testing
`mesh_jump_through_floor`'s own drivethrough side wall directly: a tank
collided with it before this, despite `drivethrough` being right there on
the parsed face the whole time.

**A tank now slides off a mesh face instead of stopping dead against it.**
Checking upstream first paid off again: `MeshFace::getHitNormal`
(MeshFace.cxx:437) is explicitly marked "FIXME - all geometry after this
point is currently JUNK" and ignores every argument it takes -- it just
returns whichever face's own plane, full stop. No top/bottom split, no
picking the "right" face among several touched at once; `findMeshHitFace`'s
own first-match face already is upstream's whole answer, so
`getTankHitNormal`'s new mesh case is one line, `getMeshHitNormal` reused
as-is from the shot path. Before this, a mesh fell through to the box-shaped
`getSideNormal` fallback, dividing by a mesh's missing `w`/`d` -- verified
against hand-built wall and floor faces (a vertical face returns its
horizontal normal, a horizontal one its vertical) before this reached the
live server.

**A tank no longer hangs motionless driving off a mesh edge, or stalls
sliding along one at an angle.** `resolveTankMotion`'s own search resolves
a hit by binary-searching the step for the last clear moment, *then* asks
whether the hit's normal actually opposed the tank's velocity -- but a
mesh's per-face test can report "still touching this one wall" for the
tank's entire own length of travel (`2 * TANK_HALF_LENGTH`, six units)
while it walks out through a full-height wall from the inside (off the
edge of `mesh_octagon`'s own roof, where the roof and a wall meet) or
slides along one at an angle. Since a single frame's motion never covers
six units, the search resolves to "no progress possible" every single
frame -- a Zeno stall, not a fall or a slide. A box never reaches this
state, because its *combined* footprint test reports "outside" the instant
a tank truly clears it, with no lingering per-face "still touching" to get
stuck in.

Checked upstream rather than inventing a fix: `World::hitBuilding`
(World.cxx:367-380) does not even accept a candidate face as a hit unless
it is a flat top/bottom (`MeshFace::isUpPlane`/`isDownPlane`, a fudge off
dead flat) or the query's own velocity actually dots negative against the
face's outward normal (`scratchPad < 0.0`) -- a face the query is moving
*along* or *away from* is never a blocker, no matter how much of its own
extent still geometrically overlaps that face's plane. bzo had the check
backwards: it accepted the geometric overlap as the hit first, and only
consulted the normal afterward to decide whether to cancel velocity, by
which point the search had already collapsed to zero progress. Ported as
`meshFaceBlocksDirection`, threaded through `findMeshHitFace`/
`findMeshHitFaceOriented` (and so `findTankObstacle`'s and
`getTankHitNormal`'s own mesh branches, the client's `hitTest`/`getNormal`
pair) as an optional `direction` -- null for a static, non-directional
query (upstream's own `!directional`), which still treats every touching
face as blocking exactly as before this existed. Confirmed against
`mesh_octagon`'s own real parsed geometry: driving straight off the roof's
edge now falls and lands; sliding along a diagonal wall at an angle now
keeps sliding past it rather than freezing after the first frame; a
straight head-on approach from outside still stops flush against the
wall, unchanged.

Two more bugs turned up chasing this live against a real player's own
reported position, both fixed the same way -- checking the actual answer
the search's own callbacks gave rather than guessing:

- `getTankHitNormal`'s own face re-lookup queried at the resolved *clear*
  position, a few thousandths of a unit back from wherever `hitTest` had
  actually confirmed a touch. Right at a mesh's own corner (two faces
  meeting) that sliver was sometimes enough for the identical SAT test to
  disagree with itself between the clear point and the touching one,
  finding no face at all and falling back to a made-up "roof" normal --
  which then misclassified an ordinary slide as a landing and froze
  it. Fixed by querying at `sweep.hitX`/`hitZ` (already available in the
  `getNormal` callback, just never threaded through) instead of the clear
  position.
- A flat top/bottom's always-blocks exemption (needed so resting with zero
  vertical velocity still holds a tank up) does not check whether the
  query is actually within that face's own footprint. Right at a corner
  where a wall's own span ends, a query box wide enough to still reach the
  floor's polygon from a position genuinely outside the mesh -- past the
  wall that already, correctly, stopped blocking -- got re-blocked by the
  floor instead, with no wall involved at all: a tank standing at ground
  level near a corner could be unable to drive forward in one specific
  direction, for no reason visible from the wall it was nowhere near.
  Reproduced against a live player's own exact position (`/api/players`)
  before fixing: `meshFaceBlocksDirection` now checks
  `pointInMeshFacePolygon` for a flat face, so the exemption only fires
  within the face's real footprint, and the query falls through to the
  ordinary dot-product test (effectively: never blocks) once outside it.

**A mesh draws on the radar now too, face by face.** Upstream's own
`RadarRenderer.cxx` treats a mesh face the same independent-polygon way its
collision does: no single footprint the way a box's `w`/`d` gives one, so
`getRadarMeshFaces` (client.js) walks every face instead, in its own cached
list next to `getRadarObstacles`'s. Two of upstream's own rules carried over
exactly: only a face angled at least partly upward draws at all
(`plane[1] > 0`, bzo's Y the up axis upstream's Z is) -- its own "enhanced"
mode, the higher-quality of upstream's two, and the one bzo takes unasked
per "bzo does not mirror BZFlag's client display options" (AGENTS.md) -- and
a face's own `noradar` (inherited from the mesh's default the same as any
other material property) drops it. Depth shading uses the *mesh's* own
vertical span rather than one infinitely thin face's, upstream's own
`useMeshForRadar` fallback for exactly that reason. Confirmed against
`bzo.bzw`'s own three fixtures directly: `mesh_billboard`'s two faces are
both vertical and neither draws; `mesh_cube`'s top face draws, matching
upstream's real behaviour exactly -- including a wrinkle borrowed straight
from the wiki.bzflag.org cube example rather than authored by bzo:
`mesh_cube`'s *bottom* face also has an upward-pointing plane (its winding
was never made outward-consistent, since collision -- the only thing that
reads a mesh face's plane until now -- never cared about the sign), so it
draws too. Not a bug in the port; a property of unwound test data, worth
remembering if a real map's own mesh floors look doubled on radar.

- [ ] Collision-log naming for a mesh's own individual faces, the way a
      box's face selectors are named today -- a debug label is not: a mesh
      now gets one the same way a box or a pyramid does, `_addDebugLabel`
      reading its own already-computed geometry bounding box, `'mesh'` its
      own type for `_clearDebugLabels` to sweep independent of
      `clearObstacles`'s own `'obstacle'` sweep. Confirmed against the three
      `bzo.bzw` fixtures directly: each carries a label, correctly named and
      floating at its own true top plus 2, not a hardcoded one.

**Debug Geometry's own support-surface outline has a mesh case now too.**
`getMotionSurfaceOutlinePoints` (client.js) used to read `obstacle.w`/`.d`/
`.rotation` unconditionally -- all `undefined` for a mesh, so standing on one
with Debug Geometry on drew no outline at all rather than a broken one (the
point count stayed 4, just every point `NaN`). A mesh needs none of that
reconstruction anyway: its faces already are its footprint, in world space
already, so the fix finds whichever face the tank is actually touching (the
same oriented-box/cylinder split `getTankHitNormal` uses) and outlines that
face's own real vertices directly.
- [ ] `arc`/`cone`/`sphere`/`tetra` as mesh generators once mesh itself works
      -- each expands to a `mesh` upstream (`CustomArc.cxx`, `CustomCone.cxx`,
      `CustomSphere.cxx`, `CustomTetra.cxx`), so they are a parser-side
      convenience on top of the same collision and render path, not a second
      implementation. Lowest priority of the four kinds of geometry here: no
      example map and no finished doc page for any of them turned up, so there
      is nothing to validate against but the upstream source itself. `bzo.bzw`'s
      own `mesh_octagon` (added to test the oriented tank box, see above) is a
      hand-built stand-in for what a `cone` with 8 sides would generate, so
      there is now at least one non-rectangular collidable mesh to test
      against without this.
- [ ] The eighth dimension (`OO`) has no mesh case. `_getInsideBuildingNode`
      (render.js) reads `obs.w`/`obs.d` directly, both `undefined` for a mesh,
      so every scattered point comes out `NaN` -- discovered by
      `mesh_octagon` above (the whole reason it exists: one mesh a tank can
      stand inside, instead of the box-emulated octagon's four, which already
      had this problem before anyone noticed since `OO` was never carried
      into the merge that added meshes to `obstacles`). Not a quick fix:
      upstream's own `SceneDatabaseBuilder::addMesh` does not reuse
      `EighthDBoxSceneNode`'s random-point-cloud approach at all for a mesh --
      `EighthDimShellNode` wraps the mesh's own already-built render nodes and
      draws each triangle as a translucent "shell" instead, which is a
      genuinely different technique, not a bounds-based version of the
      existing one.

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
  same URL now, permanently: the browser refuses the load (no
  `Access-Control-Allow-Origin` from that host, checked directly) and it
  falls back to `boxwall`, but it costs nothing to leave in and starts
  showing the real picture the moment that ever changes.

This is what made resolving a named texture against bzo's *existing* asset
set almost the whole of what a real map's `material` block asks for, with an
absolute URL -- the one thing left outside that asset set -- read too, but
never fetched by bzo's own server: see "Materials" in `docs/bzw.md` for the
client-side trust decision (`isExternalTextureUrlTrusted` in
`public/texture.js`) and why upstream's own `images.bzflag.org` fails it at
the browser's CORS check today regardless. Geometry-wise, two of the four
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
