declare module "virtual:settings-index" {
  const index: import("./types").SettingsIndex;
  export default index;
}

declare module "virtual:docs-index" {
  const index: import("./types").DocEntry[];
  export default index;
}
