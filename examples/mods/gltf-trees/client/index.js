// glTF trees: two of the client's tree models (RSM, under data/model/)
// drawn from glTF files shipped beside this file. Every placement of the
// original on every map gets the new tree, fitted to the original's height
// and standing where it stood.

export default function init(parameters, api) {
    const size = Math.min(Math.max(Number(parameters?.size) || 100, 50), 200) / 100;
    const here = file => new URL(file, import.meta.url).href;
    api.models.replace({
        // 나무잡초꽃 is the client's "trees, grass, flowers" folder.
        '나무잡초꽃/나무01.rsm': { url: here('CommonTree_3.gltf'), size },
        '나무잡초꽃/나무02.rsm': { url: here('CommonTree_5.gltf'), size },
    });
}
