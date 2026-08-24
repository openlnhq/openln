# openLN typed plugin API

`core` owns identity, wallet connections, authorization, and (Phase 2) payment settlement. Plugins are compile-time TypeScript modules imported at startup; core never evaluates plugin code supplied at runtime.

`OpenLnPlugin` in `core/plugins/api.ts` exposes typed `routes`, `uiSlots`, `settings`, and ordered SQL `migrations`. Settings and tables are namespaced by plugin; secret settings are never returned to clients. Registration rejects invalid and duplicate IDs. Payment behavior is not a plugin extension point: settlement remains in core with its append-only flight recorder.

```ts
registry.register({id:"cards",version:"0.1.0",routes:[],uiSlots:["dashboard"],settings:[],migrations:[]});
```
