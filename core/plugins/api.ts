export type UiSlot = "dashboard" | "navigation" | "settings";
export interface PluginRoute { method: "GET"|"POST"|"PATCH"|"DELETE"; path:string; handler:string }
export interface PluginSetting { key:string; label:string; secret?:boolean }
export interface PluginMigration { version:number; sql:string }
export interface OpenLnPlugin { id:string; version:string; routes:readonly PluginRoute[]; uiSlots:readonly UiSlot[]; settings:readonly PluginSetting[]; migrations:readonly PluginMigration[] }
export class PluginRegistry { private readonly plugins=new Map<string,OpenLnPlugin>(); register(p:OpenLnPlugin){if(!/^[a-z][a-z0-9-]{1,62}$/.test(p.id))throw new Error(`Invalid plugin id: ${p.id}`);if(this.plugins.has(p.id))throw new Error(`Plugin already registered: ${p.id}`);this.plugins.set(p.id,p)} list(){return [...this.plugins.values()]} get(id:string){return this.plugins.get(id)} }
