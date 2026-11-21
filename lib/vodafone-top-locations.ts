import {runtimeKind} from './runtime';
import {readVodafoneTopLocationsFile} from './vodafone-top-locations-file';
export type {VodafoneTopLocation} from './vodafone-top-locations-schema';

export async function readVodafoneTopLocations() {
  return runtimeKind==='node'?readVodafoneTopLocationsFile():[];
}
