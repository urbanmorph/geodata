// Build-time keys Vite inlines from VITE_* variables (read from geodata/.env.local
// locally, GitHub secrets in CI; see vite.config.ts envDir). Only the ones web uses.
interface ImportMetaEnv {
  /** ArcGIS Location Platform key for the satellite basemap (shared/esri-imagery.ts). */
  readonly VITE_ARCGIS_KEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
