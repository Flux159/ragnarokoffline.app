# Example: glTF trees

Replaces two of the client's tree models with glTF ones, on every map
that uses them:

| Map model (RSM) | Drawn as |
|---|---|
| `나무잡초꽃/나무01.rsm` (tree 01, everywhere in the fields) | `CommonTree_3.gltf` (3,500 triangles) |
| `나무잡초꽃/나무02.rsm` (tree 02) | `CommonTree_5.gltf` (3,200 triangles) |

`api.models.replace` takes RSM names (as under `data/model/`, Korean and
all) and a `.glb` or `.gltf` URL each. The client leaves those models out
of the map and hands every placement to the replacement, which is fitted
to the original's height (`size` scales that; `scale` sets it outright),
stands on the original's base, and turns as it turned. They are lit by the
map's sun, ambient light and fog.

glTF support: triangle meshes with normals and texture coordinates, node
hierarchies, base colour factors and textures, alpha mask and blend. Not
skins, animation or morph targets.

The trees are from Quaternius's [Stylized Nature MegaKit](https://quaternius.com/packs/stylizednaturemegakit.html)
(free version), CC0 1.0 (see `client/QUATERNIUS-LICENSE.txt`): painted bark
and alpha-masked leaves. The textures are reduced to 512x512, and the bark's
normal map is left out (the client does not use one).
