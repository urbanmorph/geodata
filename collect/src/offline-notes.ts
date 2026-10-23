// What collect says when something can't load for lack of a connection, so a
// person in the field knows it is the signal, not the map, and that the points
// they add are still kept on the phone (outbox.ts) and sent later.

export { isConnectionError } from '../../shared/connection';

/** The note over the map when its background tiles can't load. */
export function basemapOfflineNote(basemap: { id: string; name: string }): string {
  const where =
    basemap.id === 'liberty'
      ? "the map background isn't saved on this phone"
      : `${basemap.name} needs the internet`;
  return `No connection: ${where}. Your points still save, and are sent when you're back online.`;
}
