# Client API example

Copy this folder into `state/mods`, then reload the game. It shows the current
map name in the bottom-right corner and outlines ChatBox. Map transitions hide
the label until the new map loads; component removal and plugin disposal remove
all owned elements. The example requires client API 1 and does not import
roBrowser's internal modules. See [the API contract](../../../docs/MODDING.md#client-api-1).
